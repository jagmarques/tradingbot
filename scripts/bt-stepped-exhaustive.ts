/**
 * Exhaustive 2-stage stepped trail backtest
 *
 * Uses same simulation engine as bt-stepped-trail-sweep.ts.
 * Chronological 5m-bar simulation with GARCH signal check at 1h boundaries.
 * Intrabar H/L for peak, bar close for trail trigger (matching sweep script).
 *
 * Strategy: GARCH v2 only ($9 margin, z=4.5/3.0, SL 3%, TP 7%, 72h hold)
 * BTC filter: 4h EMA(12/21) for longs, 1h EMA(9/21) for direction (matching sweep)
 * Max 7 positions
 *
 * Stepped trail:
 *   Below s1Act: no trail
 *   s1Act <= peak < s2Act: trail if close <= peak - s1Dist
 *   peak >= s2Act: trail if close <= peak - s2Dist (tighter)
 *
 * Grid:
 *   s1Act: 15, 18, 20, 22, 25, 27
 *   s1Dist: 3, 4, 5, 6, 7
 *   s2Act: 30, 33, 35, 37, 40
 *   s2Dist: 1, 2, 3
 *   Valid: s2Act > s1Act AND s2Dist < s1Dist
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-stepped-exhaustive.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface C { t: number; o: number; h: number; l: number; c: number; }

// ─── Constants ─────────────────────────────────────────────────────────────────

const CD_5M = "/tmp/bt-pair-cache-5m";

const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const M5 = 5 * 60_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;
const LEV = 10;
const MAX_POS = 7;
const MARGIN = 9;
const SL_PCT = 0.03;
const TP_PCT = 0.07;
const MAX_HOLD_H = 72;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();

const PAIRS = [
  "OP","WIF","ARB","LDO","TRUMP","DASH","DOT","ENA","DOGE","APT",
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET",
];

const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4,
  WLD: 4e-4, DOT: 4.95e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  BTC: 0.5e-4, SOL: 2.0e-4, ETH: 1.0e-4, WIF: 5.05e-4, DASH: 7.15e-4,
  TIA: 4e-4, AVAX: 3e-4, NEAR: 4e-4, SUI: 3e-4, FET: 4e-4, ZEC: 4e-4,
};

// ─── Data loading ──────────────────────────────────────────────────────────────

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

// ─── Indicators ────────────────────────────────────────────────────────────────

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
      ema[i] = values[i] * k + ema[i-1] * (1 - k);
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
      const r = cs[j].c / cs[j-1].c - 1;
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

// ─── Cost helpers ──────────────────────────────────────────────────────────────

function getSpread(pair: string): number { return SP[pair] ?? 8e-4; }
function applyEntryPx(pair: string, dir: "long"|"short", raw: number): number {
  const sp = getSpread(pair);
  return dir === "long" ? raw * (1 + sp) : raw * (1 - sp);
}
function applyExitPx(pair: string, dir: "long"|"short", raw: number, isSL: boolean): number {
  const sp = getSpread(pair);
  const slip = isSL ? sp * SL_SLIP : sp;
  return dir === "long" ? raw * (1 - slip) : raw * (1 + slip);
}
function calcPnl(dir: "long"|"short", ep: number, xp: number, notional: number): number {
  return (dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional) - notional * FEE * 2;
}

// ─── Load data ─────────────────────────────────────────────────────────────────

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

// BTC 4h EMA(12/21) — used by sweep script's btcBullish (for longs)
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

// BTC 1h EMA(9/21) — used by checkGarchV2 for directional BTC filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21 = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21[prev]) return "short";
  return null;
}

// ─── Per-pair indicators ───────────────────────────────────────────────────────

interface PairInd {
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4Z: number[];
  h4TsMap: Map<number, number>;
  bars5m: C[];
}

const pairInd = new Map<string, PairInd>();
for (const pair of PAIRS) {
  const h1 = h1Data.get(pair) ?? [];
  const h4 = h4Data.get(pair) ?? [];
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
  pairInd.set(pair, { h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h4Z, h4TsMap, bars5m });
}

console.log(`  Loaded ${raw5m.size} pairs\n`);

// ─── GARCH v2 signal check ─────────────────────────────────────────────────────

interface SignalResult {
  dir: "long"|"short";
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

  const prev = barIdx - 1;
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

  // BTC 1h EMA(9/21) directional filter
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong && btcT !== "long") return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long"|"short" = goLong ? "long" : "short";
  const ep = h1[barIdx].o;
  let sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl };
}

// ─── Simulation (5m-bar chronological, matching sweep script logic) ────────────

interface Position {
  pair: string;
  dir: "long"|"short";
  entryPrice: number;  // raw price for SL/TP calc
  effectiveEP: number; // spread-adjusted for PnL calc
  sl: number;
  entryTime: number;
  peakPnlPct: number;
}

interface ClosedTrade {
  exitTime: number;
  pnl: number;
  reason: string;
}

function get5mBar(pair: string, t: number): C | null {
  const ind = pairInd.get(pair);
  if (!ind || ind.bars5m.length === 0) return null;
  const bars = ind.bars5m;
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t <= t) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found >= 0 ? bars[found] : null;
}

// 2-stage stepped trail: returns trail distance given current peak and config
function getTrailDist(peakPct: number, s1Act: number, s1Dist: number, s2Act: number, s2Dist: number): number {
  if (peakPct >= s2Act) return s2Dist;
  if (peakPct >= s1Act) return s1Dist;
  return 0; // trail not yet active
}

function runSim(
  s1Act: number, s1Dist: number,
  s2Act: number, s2Dist: number,
): ClosedTrade[] {
  const openPos: Position[] = [];
  const closed: ClosedTrade[] = [];
  const NOT = MARGIN * LEV;

  function closeAt(idx: number, exitTime: number, rawPrice: number, reason: string, isSL: boolean): void {
    const pos = openPos[idx];
    const xp = applyExitPx(pos.pair, pos.dir, rawPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, NOT);
    closed.push({ exitTime, pnl, reason });
    openPos.splice(idx, 1);
  }

  // Step at 5m intervals
  for (let t = FULL_START; t < FULL_END; t += M5) {

    // 1) Check all open positions using current 5m bar
    for (let pi = openPos.length - 1; pi >= 0; pi--) {
      const pos = openPos[pi];
      const bar = get5mBar(pos.pair, t);
      if (!bar) continue;

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closeAt(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closeAt(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP 7%
      const tp = pos.dir === "long"
        ? pos.entryPrice * (1 + TP_PCT)
        : pos.entryPrice * (1 - TP_PCT);
      if (pos.dir === "long" && bar.h >= tp) {
        closeAt(pi, t, tp, "tp", false);
        continue;
      }
      if (pos.dir === "short" && bar.l <= tp) {
        closeAt(pi, t, tp, "tp", false);
        continue;
      }

      // Max hold 72h
      if (t - pos.entryTime >= MAX_HOLD_H * H) {
        closeAt(pi, t, bar.c, "mh", false);
        continue;
      }

      // Peak update: use intrabar H/L (matching sweep script)
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // Stepped trail check
      const trailDist = getTrailDist(pos.peakPnlPct, s1Act, s1Dist, s2Act, s2Dist);
      if (trailDist > 0) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - trailDist) {
          closeAt(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // 2) New GARCH entries at 1h boundaries only
    if (t % H !== 0) continue;

    for (const pair of PAIRS) {
      if (openPos.some(p => p.pair === pair)) continue;
      if (openPos.length >= MAX_POS) break;
      const sig = checkGarchV2(pair, t);
      if (!sig) continue;
      const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
      openPos.push({
        pair, dir: sig.dir,
        entryPrice: sig.entryPrice,
        effectiveEP: ep,
        sl: sig.sl,
        entryTime: t,
        peakPnlPct: 0,
      });
    }
  }

  // Close remaining at end
  for (let pi = openPos.length - 1; pi >= 0; pi--) {
    const pos = openPos[pi];
    const bar = get5mBar(pos.pair, FULL_END - M5);
    if (!bar) { openPos.splice(pi, 1); continue; }
    closeAt(pi, FULL_END, bar.c, "eop", false);
  }

  return closed;
}

// ─── Metrics ───────────────────────────────────────────────────────────────────

interface Stats {
  trades: number;
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  trailExits: number;
}

function computeStats(trades: ClosedTrade[], startTs: number, endTs: number): Stats {
  const days = (endTs - startTs) / D;
  const inRange = trades.filter(t => t.exitTime >= startTs && t.exitTime < endTs);
  if (inRange.length === 0) return { trades: 0, wr: 0, pf: 0, total: 0, perDay: 0, maxDD: 0, sharpe: 0, trailExits: 0 };

  const wins = inRange.filter(t => t.pnl > 0);
  const losses = inRange.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = inRange.reduce((s, t) => s + t.pnl, 0);

  const sorted = [...inRange].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of inRange) {
    const d = Math.floor(t.exitTime / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const rets = [...dayPnl.values()];
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const std = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  return {
    trades: inRange.length,
    wr: wins.length / inRange.length * 100,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits: inRange.filter(t => t.reason === "trail").length,
  };
}

// ─── Grid ──────────────────────────────────────────────────────────────────────

const STAGE1_ACTS  = [15, 18, 20, 22, 25, 27];
const STAGE1_DISTS = [3, 4, 5, 6, 7];
const STAGE2_ACTS  = [30, 33, 35, 37, 40];
const STAGE2_DISTS = [1, 2, 3];

const grid: Array<{ s1a: number; s1d: number; s2a: number; s2d: number }> = [];
for (const s1a of STAGE1_ACTS) {
  for (const s1d of STAGE1_DISTS) {
    for (const s2a of STAGE2_ACTS) {
      for (const s2d of STAGE2_DISTS) {
        if (s2a <= s1a) continue;
        if (s2d >= s1d) continue;
        grid.push({ s1a, s1d, s2a, s2d });
      }
    }
  }
}

// ─── Run baseline ──────────────────────────────────────────────────────────────

console.log("Running baseline (no trail)...");
const baseTrades = runSim(9999, 0, 9999, 0);  // activation impossibly high = no trail
const baseFS = computeStats(baseTrades, FULL_START, FULL_END);
const baseOS = computeStats(baseTrades, OOS_START, FULL_END);
console.log(`  Baseline: $${baseFS.perDay.toFixed(2)}/day, MaxDD $${baseFS.maxDD.toFixed(0)}, PF ${baseFS.pf.toFixed(2)}, WR ${baseFS.wr.toFixed(1)}%, Trades ${baseFS.trades}`);

// Also run the reference config 25/5->40/2
console.log("Running reference config 25/5->40/2...");
const refTrades = runSim(25, 5, 40, 2);
const refFS = computeStats(refTrades, FULL_START, FULL_END);
const refOS = computeStats(refTrades, OOS_START, FULL_END);
console.log(`  25/5->40/2: $${refFS.perDay.toFixed(2)}/day, MaxDD $${refFS.maxDD.toFixed(0)}, PF ${refFS.pf.toFixed(2)}, WR ${refFS.wr.toFixed(1)}%, Trails ${refFS.trailExits}`);

// ─── Run grid ──────────────────────────────────────────────────────────────────

interface GridResult {
  label: string;
  s1a: number; s1d: number; s2a: number; s2d: number;
  trades: number;
  wr: number;
  perDay: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  trailExits: number;
  total: number;
  oosPerDay: number;
  oosPf: number;
  efficiency: number;
}

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log(`\nRunning ${grid.length} stepped trail configs (5m simulation)...\n`);

const allResults: GridResult[] = [];
let done = 0;

for (const { s1a, s1d, s2a, s2d } of grid) {
  const label = `${s1a}/${s1d}->${s2a}/${s2d}`;
  const trades = runSim(s1a, s1d, s2a, s2d);
  const fs = computeStats(trades, FULL_START, FULL_END);
  const os = computeStats(trades, OOS_START, FULL_END);

  allResults.push({
    label, s1a, s1d, s2a, s2d,
    trades: fs.trades,
    wr: fs.wr,
    perDay: fs.perDay,
    pf: fs.pf,
    sharpe: fs.sharpe,
    maxDD: fs.maxDD,
    trailExits: fs.trailExits,
    total: fs.total,
    oosPerDay: os.perDay,
    oosPf: os.pf,
    efficiency: fs.maxDD > 0 ? fs.perDay / fs.maxDD : 0,
  });

  done++;
  if (done % 10 === 0 || done === grid.length) {
    process.stdout.write(`\r  Progress: ${done}/${grid.length} (${((done/grid.length)*100).toFixed(0)}%)   `);
  }
}

console.log("\n");

// ─── Output ────────────────────────────────────────────────────────────────────

const THRESHOLD = 1.50;
const qualifying = allResults.filter(r => r.perDay >= THRESHOLD);
qualifying.sort((a, b) => a.maxDD - b.maxDD);
const top20 = qualifying.slice(0, 20);

const bestEff = qualifying.length > 0
  ? qualifying.reduce((best, r) => r.efficiency > best.efficiency ? r : best)
  : null;

const top5ByDay = [...allResults]
  .filter(r => r.perDay >= THRESHOLD)
  .sort((a, b) => b.perDay - a.perDay)
  .slice(0, 5);

const W = 130;
const SEP = "=".repeat(W);
const sep = "-".repeat(W);

console.log(SEP);
console.log("STEPPED TRAIL EXHAUSTIVE BACKTEST - GARCH v2 ONLY");
console.log(`Config: $${MARGIN} margin, 10x lev, z=4.5/3.0, SL ${SL_PCT*100}%, TP ${TP_PCT*100}%, ${MAX_HOLD_H}h hold, max ${MAX_POS} positions`);
console.log(`BTC filter: 4h EMA(12/21) for longs, 1h EMA(9/21) direction | 5m simulation | ${PAIRS.length} pairs`);
console.log(`Full: 2023-01 to 2026-03 (${fullDays.toFixed(0)}d) | OOS: 2025-09+ (${oosDays.toFixed(0)}d)`);
console.log(`Grid: ${grid.length} valid 2-stage configs`);
console.log(SEP);

console.log("\nBASELINE (no trail):");
console.log(`  $/day $${baseFS.perDay.toFixed(2)}, MaxDD $${baseFS.maxDD.toFixed(0)}, PF ${baseFS.pf.toFixed(2)}, WR ${baseFS.wr.toFixed(1)}%, Sharpe ${baseFS.sharpe.toFixed(2)}, Trades ${baseFS.trades}, OOS $/day $${baseOS.perDay.toFixed(2)}`);

console.log("\nREFERENCE 25/5->40/2 (prev best):");
console.log(`  $/day $${refFS.perDay.toFixed(2)}, MaxDD $${refFS.maxDD.toFixed(0)}, PF ${refFS.pf.toFixed(2)}, WR ${refFS.wr.toFixed(1)}%, Sharpe ${refFS.sharpe.toFixed(2)}, Trails ${refFS.trailExits}, OOS $/day $${refOS.perDay.toFixed(2)}`);

console.log(`\n${sep}`);
console.log(`TOP 20 BY LOWEST MaxDD ($/day >= $${THRESHOLD}) — ${qualifying.length} configs qualify out of ${grid.length}:`);
console.log(sep);

const hdr =
  "Config".padEnd(20) +
  "Trades".padStart(7) +
  "WR%".padStart(7) +
  "$/day".padStart(8) +
  "PF".padStart(6) +
  "Sharpe".padStart(8) +
  "MaxDD".padStart(8) +
  "Trails".padStart(7) +
  "Effcy".padStart(8) +
  " | OOS$/d".padStart(10) +
  " OOSPF".padStart(8);

console.log(hdr);
console.log(sep);

for (const r of top20) {
  console.log(
    r.label.padEnd(20) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    r.sharpe.toFixed(2).padStart(8) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    String(r.trailExits).padStart(7) +
    r.efficiency.toFixed(4).padStart(8) +
    " | " +
    ("$" + r.oosPerDay.toFixed(2)).padStart(7) +
    r.oosPf.toFixed(2).padStart(8),
  );
}

console.log("\n" + SEP);

if (bestEff) {
  console.log("BEST EFFICIENCY ($/day / MaxDD) where $/day >= $1.50:");
  console.log(`  Config: ${bestEff.label}`);
  console.log(`  $/day $${bestEff.perDay.toFixed(2)}, MaxDD $${bestEff.maxDD.toFixed(0)}, PF ${bestEff.pf.toFixed(2)}, WR ${bestEff.wr.toFixed(1)}%, Sharpe ${bestEff.sharpe.toFixed(2)}, Efficiency ${bestEff.efficiency.toFixed(4)}, OOS $/day $${bestEff.oosPerDay.toFixed(2)}`);
} else {
  console.log("BEST EFFICIENCY: no configs qualify at $1.50/day threshold");
}

if (top5ByDay.length > 0) {
  console.log("\nTOP 5 BY $/day (>= $1.50):");
  for (const r of top5ByDay) {
    console.log(`  ${r.label.padEnd(20)}  $/day $${r.perDay.toFixed(2)}, MaxDD $${r.maxDD.toFixed(0)}, Eff ${r.efficiency.toFixed(4)}, Sharpe ${r.sharpe.toFixed(2)}, OOS $${r.oosPerDay.toFixed(2)}`);
  }
}

if (qualifying.length > 0) {
  const minDD = qualifying[0].maxDD;
  const maxDDq = qualifying[qualifying.length - 1].maxDD;
  const betterDD = qualifying.filter(r => r.maxDD < baseFS.maxDD);
  console.log(`\nSUMMARY:`);
  console.log(`  Qualifying configs (>= $${THRESHOLD}/day): ${qualifying.length}/${grid.length}`);
  console.log(`  MaxDD range among qualifying: $${minDD.toFixed(0)} - $${maxDDq.toFixed(0)} (baseline: $${baseFS.maxDD.toFixed(0)})`);
  console.log(`  Configs beating baseline MaxDD ($${baseFS.maxDD.toFixed(0)}): ${betterDD.length}`);
} else {
  // No configs qualify — show top 10 overall by $/day anyway
  const top10 = [...allResults].sort((a, b) => b.perDay - a.perDay).slice(0, 10);
  console.log(`\nNo configs reach $${THRESHOLD}/day. TOP 10 OVERALL (any $/day):`);
  console.log(sep);
  console.log(hdr);
  console.log(sep);
  for (const r of top10) {
    console.log(
      r.label.padEnd(20) +
      String(r.trades).padStart(7) +
      (r.wr.toFixed(1) + "%").padStart(7) +
      ("$" + r.perDay.toFixed(2)).padStart(8) +
      r.pf.toFixed(2).padStart(6) +
      r.sharpe.toFixed(2).padStart(8) +
      ("$" + r.maxDD.toFixed(0)).padStart(8) +
      String(r.trailExits).padStart(7) +
      r.efficiency.toFixed(4).padStart(8) +
      " | " +
      ("$" + r.oosPerDay.toFixed(2)).padStart(7) +
      r.oosPf.toFixed(2).padStart(8),
    );
  }
}

console.log("\n" + SEP);
console.log("Done.");
