/**
 * 3-Stage Trailing Stop Backtest
 * GARCH v2 only: $9 margin, z=4.5/3.0, SL 3%, TP 7%, 72h hold, max 7
 * BTC filter: 4h EMA(12) > EMA(21)
 *
 * 3-stage trail logic:
 *   Stage 1: peak >= A => trail distance D1 (loose, let it run)
 *   Stage 2: peak >= B => trail tightens to D2
 *   Stage 3: peak >= C => trail tightens to D3 (lock in)
 *   (A < B < C required)
 *
 * Compare to:
 *   No trail:         $2.21/day, $96 DD
 *   Flat 30/3 (live): $1.83/day, $55 DD
 *   2-stage 25/6->35/1: $1.84/day, $47 DD
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-3stage-trail.ts
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
  "LINK","ADA","WLD","XRP","UNI","ETH","TIA","SOL","ZEC","AVAX","NEAR","SUI","FET",
];

const GARCH_SIZE = 9;
const MAX_POS = 7;
const GARCH_SL_PCT = 0.03;
const GARCH_TP_PCT = 0.07;
const GARCH_HOLD_H = 72;

// ─── Data helpers ──────────────────────────────────────────────────────────────

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

// ─── Indicators ────────────────────────────────────────────────────────────────

function calcATR(cs: C[], period: number): number[] {
  const trs = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    trs[i] = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i-1].c), Math.abs(cs[i].l - cs[i-1].c));
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

// ─── Cost helpers ───────────────────────────────────────────────────────────────

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
console.log(`  Loaded ${raw5m.size} pairs.\n`);

// ─── BTC 4h EMA(12/21) filter ──────────────────────────────────────────────────

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

// BTC 1h EMA(9/21) for GARCH entry filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, 9);
const btcH1Ema21h = calcEMA(btcH1Closes, 21);
const btcH1TsMap = new Map<number, number>();
btcH1.forEach((c, i) => btcH1TsMap.set(c.t, i));

function btcH1Trend(t: number): "long"|"short"|null {
  const bucket = Math.floor(t / H) * H;
  const idx = btcH1TsMap.get(bucket);
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (btcH1Ema9[prev] > btcH1Ema21h[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21h[prev]) return "short";
  return null;
}

// ─── Per-pair indicators ────────────────────────────────────────────────────────

interface PairIndicators {
  h4: C[];
  h4TsMap: Map<number, number>;
  h1: C[];
  h1Z: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4Z: number[];
  bars5m: C[];
}

const pairInd = new Map<string, PairIndicators>();

for (const pair of PAIRS) {
  const h4 = h4Data.get(pair) ?? [];
  const h4Z = computeZScores(h4, 3, 20);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));

  const h1 = h1Data.get(pair) ?? [];
  const h1Z = computeZScores(h1, 3, 20);
  const h1Closes = h1.map(c => c.c);
  const h1Ema9 = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const bars5m = raw5m.get(pair) ?? [];

  pairInd.set(pair, { h4, h4TsMap, h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h4Z, bars5m });
}

// ─── GARCH entry/exit ──────────────────────────────────────────────────────────

interface SignalResult {
  dir: "long"|"short";
  entryPrice: number;
  sl: number;
}

function checkGarch(pair: string, t: number): SignalResult | null {
  const ind = pairInd.get(pair)!;
  const h1 = ind.h1;
  if (h1.length < 200) return null;
  const h1Bucket = Math.floor(t / H) * H;
  const barIdx = ind.h1TsMap.get(h1Bucket);
  if (barIdx === undefined || barIdx < 24) return null;

  const i = barIdx;
  const prev = i - 1;
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

  const dir: "long"|"short" = goLong ? "long" : "short";
  const ep = h1[i].o;
  let sl = dir === "long" ? ep * (1 - GARCH_SL_PCT) : ep * (1 + GARCH_SL_PCT);
  if (dir === "long") sl = Math.max(sl, ep * 0.965);
  else sl = Math.min(sl, ep * 1.035);

  return { dir, entryPrice: ep, sl };
}

// ─── Position type ─────────────────────────────────────────────────────────────

interface Position {
  pair: string;
  dir: "long"|"short";
  entryPrice: number;   // raw (no spread), for TP/trail calculations
  effectiveEP: number;  // with spread applied
  sl: number;
  entryTime: number;
  peakPnlPct: number;
}

interface ClosedTrade {
  pair: string;
  dir: "long"|"short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
}

// ─── 3-stage trail simulation ──────────────────────────────────────────────────
// Trail distance determined by stage:
//   peak < A: no trail
//   peak in [A, B): distance = D1
//   peak in [B, C): distance = D2
//   peak >= C:      distance = D3

function getTrailDist(peak: number, A: number, B: number, C: number, D1: number, D2: number, D3: number): number {
  if (peak >= C) return D3;
  if (peak >= B) return D2;
  if (peak >= A) return D1;
  return 0;
}

function bsearch5m(bars: C[], t: number): number {
  let lo = 0, hi = bars.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t >= t) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return found;
}

function runSim(
  A: number, D1: number,
  B: number, D2: number,
  C: number, D3: number,
  startTs: number,
  endTs: number,
): ClosedTrade[] {
  const openPositions: Position[] = [];
  const closedTrades: ClosedTrade[] = [];

  function hasOpenPos(pair: string): boolean {
    return openPositions.some(p => p.pair === pair);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = GARCH_SIZE * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    closedTrades.push({ pair: pos.pair, dir: pos.dir, entryTime: pos.entryTime, exitTime, pnl: calcPnl(pos.dir, pos.effectiveEP, xp, notional), reason });
    openPositions.splice(idx, 1);
  }

  // Use 5m bars as the simulation clock
  // Build a union of all 5m timestamps for all pairs
  // To avoid per-minute iteration for all 23 pairs, we walk per-pair 5m bars
  // and use event-driven simulation: collect all 5m bar events, sort by time.

  // Actually, we need to check GARCH entries at 1h boundaries only.
  // Exits (SL, TP, trail) need 5m granularity.
  // Strategy: iterate 1h boundaries for entries; iterate 5m bars for exits.
  // Use chronological merge: advance through 5m time, at 1h aligned times also check entries.

  // Collect all unique timestamps
  const tSet = new Set<number>();
  for (const pair of PAIRS) {
    const bars = pairInd.get(pair)!.bars5m;
    for (const b of bars) {
      if (b.t >= startTs && b.t < endTs) tSet.add(b.t);
    }
  }
  // Also add 1h boundaries in range
  const h1Start = Math.ceil(startTs / H) * H;
  for (let t = h1Start; t < endTs; t += H) tSet.add(t);

  const allTs = [...tSet].sort((a, b) => a - b);

  for (const t of allTs) {
    // 1) Process exits for open positions using 5m bar for this pair
    for (let pi = openPositions.length - 1; pi >= 0; pi--) {
      const pos = openPositions[pi];
      const bars5m = pairInd.get(pos.pair)!.bars5m;
      const barIdx = bsearch5m(bars5m, t);
      if (barIdx < 0 || bars5m[barIdx].t !== t) continue;
      const bar = bars5m[barIdx];

      // SL
      if (pos.dir === "long" && bar.l <= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }
      if (pos.dir === "short" && bar.h >= pos.sl) {
        closePos(pi, t, pos.sl, "sl", true);
        continue;
      }

      // TP (7%)
      const tp = pos.dir === "long" ? pos.entryPrice * (1 + GARCH_TP_PCT) : pos.entryPrice * (1 - GARCH_TP_PCT);
      if (pos.dir === "long" && bar.h >= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }
      if (pos.dir === "short" && bar.l <= tp) {
        closePos(pi, t, tp, "tp", false);
        continue;
      }

      // Max hold (72h)
      if ((t - pos.entryTime) >= GARCH_HOLD_H * H) {
        closePos(pi, t, bar.c, "mh", false);
        continue;
      }

      // Peak tracking (use intrabar best price)
      const bestPct = pos.dir === "long"
        ? (bar.h / pos.entryPrice - 1) * LEV * 100
        : (pos.entryPrice / bar.l - 1) * LEV * 100;
      if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

      // 3-stage trail check
      const dist = getTrailDist(pos.peakPnlPct, A, B, C, D1, D2, D3);
      if (dist > 0) {
        const currPct = pos.dir === "long"
          ? (bar.c / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.c - 1) * LEV * 100;
        if (currPct <= pos.peakPnlPct - dist) {
          closePos(pi, t, bar.c, "trail", false);
          continue;
        }
      }
    }

    // 2) GARCH entries at 1h boundaries
    if (t % H === 0) {
      for (const pair of PAIRS) {
        if (openPositions.length >= MAX_POS) break;
        if (hasOpenPos(pair)) continue;
        const sig = checkGarch(pair, t);
        if (!sig) continue;
        const ep = applyEntryPx(pair, sig.dir, sig.entryPrice);
        openPositions.push({
          pair, dir: sig.dir,
          entryPrice: sig.entryPrice,
          effectiveEP: ep,
          sl: sig.sl,
          entryTime: t,
          peakPnlPct: 0,
        });
      }
    }
  }

  // Close remaining at end
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const bars5m = pairInd.get(pos.pair)!.bars5m;
    const lastBar = bars5m[bars5m.length - 1];
    if (lastBar) {
      closePos(pi, endTs, lastBar.c, "eop", false);
    }
  }

  return closedTrades;
}

// ─── Metrics ───────────────────────────────────────────────────────────────────

interface Metrics {
  wr: number;
  pf: number;
  total: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  trailExits: number;
  trades: number;
}

function computeMetrics(trades: ClosedTrade[], startTs: number, endTs: number): Metrics {
  const days = (endTs - startTs) / D;
  if (trades.length === 0) return { wr: 0, pf: 0, total: 0, perDay: 0, maxDD: 0, sharpe: 0, trailExits: 0, trades: 0 };

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

  return {
    wr: (wins.length / trades.length) * 100,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits,
    trades: trades.length,
  };
}

// ─── Config grid ───────────────────────────────────────────────────────────────

interface TrailConfig {
  label: string;
  A: number; D1: number;
  B: number; D2: number;
  C: number; D3: number;
}

const CONFIGS: TrailConfig[] = [
  // Baselines
  { label: "No trail",         A: 0,  D1: 0, B: 0,  D2: 0, C: 0,  D3: 0 },
  { label: "Flat 30/3",        A: 30, D1: 3, B: 999, D2: 3, C: 999, D3: 3 },
  { label: "2-stg 25/6->35/1", A: 25, D1: 6, B: 35,  D2: 1, C: 999, D3: 1 },

  // SET 1: Build on 25/6->35/1, add a middle stage
  { label: "25/6->30/3->35/1", A: 25, D1: 6, B: 30, D2: 3, C: 35, D3: 1 },
  { label: "25/6->32/3->40/1", A: 25, D1: 6, B: 32, D2: 3, C: 40, D3: 1 },
  { label: "25/6->30/4->38/1", A: 25, D1: 6, B: 30, D2: 4, C: 38, D3: 1 },
  { label: "25/7->33/3->40/1", A: 25, D1: 7, B: 33, D2: 3, C: 40, D3: 1 },
  { label: "25/6->35/2->45/1", A: 25, D1: 6, B: 35, D2: 2, C: 45, D3: 1 },

  // SET 2: Start earlier (15-20), tighten progressively
  { label: "15/7->25/4->35/1", A: 15, D1: 7, B: 25, D2: 4, C: 35, D3: 1 },
  { label: "15/7->25/3->35/1", A: 15, D1: 7, B: 25, D2: 3, C: 35, D3: 1 },
  { label: "18/6->28/3->38/1", A: 18, D1: 6, B: 28, D2: 3, C: 38, D3: 1 },
  { label: "20/6->30/3->40/1", A: 20, D1: 6, B: 30, D2: 3, C: 40, D3: 1 },
  { label: "20/7->30/4->40/1", A: 20, D1: 7, B: 30, D2: 4, C: 40, D3: 1 },
  { label: "20/5->28/3->35/1", A: 20, D1: 5, B: 28, D2: 3, C: 35, D3: 1 },

  // SET 3: Non-round numbers
  { label: "17/7->27/3->37/1", A: 17, D1: 7, B: 27, D2: 3, C: 37, D3: 1 },
  { label: "22/6->32/3->42/1", A: 22, D1: 6, B: 32, D2: 3, C: 42, D3: 1 },
  { label: "23/6->33/3->43/1", A: 23, D1: 6, B: 33, D2: 3, C: 43, D3: 1 },

  // SET 4: Very gradual tightening
  { label: "20/7->30/5->40/3", A: 20, D1: 7, B: 30, D2: 5, C: 40, D3: 3 },
  { label: "20/6->30/4->40/2", A: 20, D1: 6, B: 30, D2: 4, C: 40, D3: 2 },
  { label: "15/7->25/5->35/3", A: 15, D1: 7, B: 25, D2: 5, C: 35, D3: 3 },
  { label: "18/7->28/4->38/2", A: 18, D1: 7, B: 28, D2: 4, C: 38, D3: 2 },
];

// ─── Run all configs ───────────────────────────────────────────────────────────

interface ResultRow {
  label: string;
  trades: number;
  wr: number;
  pf: number;
  perDay: number;
  maxDD: number;
  sharpe: number;
  trailExits: number;
  oosPerDay: number;
  oosPf: number;
}

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;

console.log(`GARCH v2 only | $${GARCH_SIZE} margin, 10x lev | z=4.5/3.0 | SL ${GARCH_SL_PCT*100}%, TP ${GARCH_TP_PCT*100}%, hold ${GARCH_HOLD_H}h | max ${MAX_POS}`);
console.log(`BTC filter: 4h EMA(12/21) | 5m bar precision for trail`);
console.log(`Full: 2023-01 to 2026-03 (${fullDays.toFixed(0)}d) | OOS: 2025-09+ (${oosDays.toFixed(0)}d)\n`);

const results: ResultRow[] = [];

for (const cfg of CONFIGS) {
  process.stdout.write(`  ${cfg.label.padEnd(22)}...`);

  const fullTrades = runSim(cfg.A, cfg.D1, cfg.B, cfg.D2, cfg.C, cfg.D3, FULL_START, FULL_END);
  const fm = computeMetrics(fullTrades, FULL_START, FULL_END);

  const oosTrades = fullTrades.filter(t => t.entryTime >= OOS_START);
  const om = computeMetrics(oosTrades, OOS_START, FULL_END);

  results.push({
    label: cfg.label,
    trades: fm.trades,
    wr: fm.wr,
    pf: fm.pf,
    perDay: fm.perDay,
    maxDD: fm.maxDD,
    sharpe: fm.sharpe,
    trailExits: fm.trailExits,
    oosPerDay: om.perDay,
    oosPf: om.pf,
  });

  console.log(` $${fm.perDay.toFixed(2)}/day, DD $${fm.maxDD.toFixed(0)}, PF ${fm.pf.toFixed(2)}, OOS $${om.perDay.toFixed(2)}/day`);
}

// ─── Output table ──────────────────────────────────────────────────────────────

// Sort by MaxDD ascending
const sorted = [...results].sort((a, b) => a.maxDD - b.maxDD);

// Filter: $/day >= $1.50
const filtered = sorted.filter(r => r.perDay >= 1.50);

const W = 145;
console.log("\n" + "=".repeat(W));
console.log("3-STAGE TRAILING STOP RESULTS");
console.log(`GARCH v2 only | $${GARCH_SIZE} margin | BTC 4h EMA(12/21) | Sorted by MaxDD ascending | Min $/day >= $1.50`);
console.log(`Baselines: No trail=$2.21/day $96DD | Flat 30/3=$1.83/day $55DD | 2-stg 25/6->35/1=$1.84/day $47DD`);
console.log("=".repeat(W));

const hdr =
  "Config".padEnd(24) +
  "Trades".padStart(7) +
  " WR%".padStart(7) +
  "  PF".padStart(6) +
  " $/day".padStart(8) +
  " MaxDD".padStart(8) +
  " Sharpe".padStart(8) +
  " Trails".padStart(8) +
  " OOS$/d".padStart(9) +
  " OOSPF".padStart(8);

console.log("\n" + hdr);
console.log("-".repeat(W));

const baseline2stage = results.find(r => r.label === "2-stg 25/6->35/1");
const baseline2stageDD = baseline2stage?.maxDD ?? 47;
const baseline2stageDay = baseline2stage?.perDay ?? 1.84;

for (const r of filtered) {
  const isBaseline = r.label === "No trail" || r.label === "Flat 30/3" || r.label === "2-stg 25/6->35/1";
  const beatsBoth = !isBaseline && r.perDay > baseline2stageDay && r.maxDD < baseline2stageDD;
  const mark = beatsBoth ? " <<< BEATS 2-STAGE" : (isBaseline ? " (baseline)" : "");

  console.log(
    r.label.padEnd(24) +
    String(r.trades).padStart(7) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    r.pf.toFixed(2).padStart(6) +
    ("$" + r.perDay.toFixed(2)).padStart(8) +
    ("$" + r.maxDD.toFixed(0)).padStart(8) +
    r.sharpe.toFixed(2).padStart(8) +
    String(r.trailExits).padStart(8) +
    ("$" + r.oosPerDay.toFixed(2)).padStart(9) +
    r.oosPf.toFixed(2).padStart(8) +
    mark,
  );
}

// Also show configs excluded by $1.50 filter
const excluded = sorted.filter(r => r.perDay < 1.50);
if (excluded.length > 0) {
  console.log(`\n[Below $1.50/day threshold - excluded from ranking:]`);
  for (const r of excluded) {
    console.log(
      `  ${r.label.padEnd(22)} $${r.perDay.toFixed(2)}/day, DD $${r.maxDD.toFixed(0)}, PF ${r.pf.toFixed(2)}`,
    );
  }
}

// Summary
console.log("\n" + "=".repeat(W));
console.log("SUMMARY");
console.log("-".repeat(W));

const noTrail = results.find(r => r.label === "No trail");
const flat30 = results.find(r => r.label === "Flat 30/3");
const twoStage = results.find(r => r.label === "2-stg 25/6->35/1");

if (noTrail) console.log(`  No trail:           $${noTrail.perDay.toFixed(2)}/day, MaxDD $${noTrail.maxDD.toFixed(0)}, PF ${noTrail.pf.toFixed(2)}, OOS $${noTrail.oosPerDay.toFixed(2)}/day`);
if (flat30)  console.log(`  Flat 30/3:          $${flat30.perDay.toFixed(2)}/day, MaxDD $${flat30.maxDD.toFixed(0)}, PF ${flat30.pf.toFixed(2)}, OOS $${flat30.oosPerDay.toFixed(2)}/day`);
if (twoStage) console.log(`  2-stg 25/6->35/1:  $${twoStage.perDay.toFixed(2)}/day, MaxDD $${twoStage.maxDD.toFixed(0)}, PF ${twoStage.pf.toFixed(2)}, OOS $${twoStage.oosPerDay.toFixed(2)}/day`);

console.log();

// Winners beating 2-stage on both metrics
const winners = filtered.filter(r => {
  const isBaseline = r.label === "No trail" || r.label === "Flat 30/3" || r.label === "2-stg 25/6->35/1";
  return !isBaseline && r.perDay > baseline2stageDay && r.maxDD < baseline2stageDD;
});

if (winners.length > 0) {
  console.log(`  3-stage configs beating 2-stage on BOTH $/day AND MaxDD:`);
  for (const r of winners) {
    console.log(`    ${r.label}: $${r.perDay.toFixed(2)}/day, DD $${r.maxDD.toFixed(0)}, PF ${r.pf.toFixed(2)}, OOS $${r.oosPerDay.toFixed(2)}/day`);
  }
} else {
  console.log(`  No 3-stage config beats 2-stage on BOTH $/day and MaxDD.`);
  // Show best trade-offs
  const byDayGe150 = filtered.filter(r => !["No trail","Flat 30/3","2-stg 25/6->35/1"].includes(r.label));
  if (byDayGe150.length > 0) {
    const bestDD = byDayGe150.slice().sort((a, b) => a.maxDD - b.maxDD)[0];
    const bestDay = byDayGe150.slice().sort((a, b) => b.perDay - a.perDay)[0];
    console.log(`  Best DD among 3-stage (>=$1.50/day): ${bestDD.label}: $${bestDD.perDay.toFixed(2)}/day, DD $${bestDD.maxDD.toFixed(0)}`);
    console.log(`  Best $/day among 3-stage (>=$1.50/day): ${bestDay.label}: $${bestDay.perDay.toFixed(2)}/day, DD $${bestDay.maxDD.toFixed(0)}`);
  }
}

console.log("\nDone.");
