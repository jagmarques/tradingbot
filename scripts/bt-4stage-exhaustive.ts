/**
 * 4-stage stepped trail exhaustive grid search for GARCH v2.
 * GARCH $9, z=4.5/3.0, SL 3%, TP 7%, 72h hold, max 7, 23 pairs, BTC 1h EMA(9/21).
 * Patterns A/B/C/D x 5 starts x 6 distance combos = 120 configs.
 * Plus baselines: no trail, flat 30/3, 3-stage 25/6->30/3->35/1.
 * Sorted by combined score: $/day - (MaxDD * 0.02).
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-4stage-exhaustive.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M  = "/tmp/bt-pair-cache-5m";
const H      = 3_600_000;
const H4     = 4 * H;
const D      = 86_400_000;
const MIN_5  = 5 * 60_000;
const FEE    = 0.000_35;
const SL_SLIP = 1.5;
const LEV    = 10;

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

// Aggregate 5m -> 1h and 4h
const h1DataMap = new Map<string, C[]>();
const h4DataMap = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  h1DataMap.set(p, aggregate(bars, H, 10));
  h4DataMap.set(p, aggregate(bars, H4, 40));
}

// BTC 1h EMA(9/21) — used for GARCH trend filter
const btcH1 = h1DataMap.get("BTC");
if (!btcH1 || btcH1.length === 0) throw new Error("BTC 5m data missing");
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
  h1: C[];
  h1Z: Float64Array;
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4: C[];
  h4Z: Float64Array;
  h4TsMap: Map<number, number>;
  bars5m: C[];
  bars5mTsMap: Map<number, number>;
}

const pairData = new Map<string, PairData>();

for (const pair of PAIRS) {
  const h1 = h1DataMap.get(pair) ?? [];
  const h1Closes = h1.map(c => c.c);
  const h1Z     = computeZScores(h1, 3, 20);
  const h1Ema9  = calcEMA(h1Closes, 9);
  const h1Ema21 = calcEMA(h1Closes, 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));

  const h4 = h4DataMap.get(pair) ?? [];
  const h4Z = computeZScores(h4, 3, 20);
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));

  const bars5m = raw5m.get(pair) ?? [];
  const bars5mTsMap = new Map<number, number>();
  bars5m.forEach((c, i) => bars5mTsMap.set(c.t, i));

  pairData.set(pair, { h1, h1Z, h1Ema9, h1Ema21, h1TsMap, h4, h4Z, h4TsMap, bars5m, bars5mTsMap });
}

h1DataMap.clear();
h4DataMap.clear();

console.log("Data ready.\n");

// --------------- 5m bar lookup ---------------
function get5mBar(pd: PairData, t: number): C | null {
  const bucket = Math.floor(t / MIN_5) * MIN_5;
  const idx = pd.bars5mTsMap.get(bucket);
  if (idx === undefined) return null;
  return pd.bars5m[idx];
}

// --------------- GARCH signal ---------------
const Z1_LONG  = 4.5;
const Z1_SHORT = 3.0;
const Z4_LONG  = 3.0;
const Z4_SHORT = 3.0;
const GARCH_SIZE = 9;
const MAX_POS    = 7;
const MAX_HOLD_H = 72;
const TP_PCT     = 0.07;
const SL_PCT     = 0.03;
const SL_CAP     = 0.035;

function checkGarch(pair: string, t: number): { dir: "long" | "short"; entryPrice: number; sl: number } | null {
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
  const goLong  = z1 > Z1_LONG;
  const goShort = z1 < -Z1_SHORT;
  if (!goLong && !goShort) return null;

  // 4h z check
  const ts4h = Math.floor(h1[prev].t / H4) * H4;
  const idx4h = pd.h4TsMap.get(ts4h);
  if (idx4h === undefined || idx4h < 23) return null;
  const z4 = pd.h4Z[idx4h];
  if (goLong  && z4 <= Z4_LONG)  return null;
  if (goShort && z4 >= -Z4_SHORT) return null;

  // Pair 1h EMA(9/21) filter
  if (!pd.h1Ema9[prev] || !pd.h1Ema21[prev]) return null;
  if (goLong  && pd.h1Ema9[prev] <= pd.h1Ema21[prev]) return null;
  if (goShort && pd.h1Ema9[prev] >= pd.h1Ema21[prev]) return null;

  // BTC 1h EMA(9/21) trend filter
  const btcT = btcH1Trend(h1[prev].t);
  if (goLong  && btcT !== "long")  return null;
  if (goShort && btcT !== "short") return null;

  const dir: "long" | "short" = goLong ? "long" : "short";
  const ep = h1[barIdx].o;
  let sl = dir === "long" ? ep * (1 - SL_PCT) : ep * (1 + SL_PCT);
  if (dir === "long") sl = Math.max(sl, ep * (1 - SL_CAP));
  else                sl = Math.min(sl, ep * (1 + SL_CAP));

  return { dir, entryPrice: ep, sl };
}

function checkGarchReentry(pair: string, t: number, wantDir: "long" | "short"): { dir: "long" | "short"; entryPrice: number; sl: number } | null {
  const sig = checkGarch(pair, t);
  if (!sig || sig.dir !== wantDir) return null;
  return sig;
}

// --------------- trail config types ---------------
interface TrailStage {
  activateAt: number; // leveraged PnL% threshold to activate this stage
  distance: number;   // trail distance in leveraged PnL%
}

interface TrailConfig {
  label: string;
  stages: TrailStage[]; // sorted by activateAt ascending; empty = no trail
  useReentry: boolean;
}

// Compute trail distance for a given peak leveraged PnL% using staged config
function getTrailDistance(stages: TrailStage[], peakPct: number): number {
  let dist = 0;
  // Walk stages in reverse to find the highest activated stage
  for (let i = stages.length - 1; i >= 0; i--) {
    if (peakPct >= stages[i].activateAt) {
      dist = stages[i].distance;
      break;
    }
  }
  return dist;
}

// --------------- build config grid ---------------

// A1 values
const A1_VALS = [15, 18, 20, 22, 25];

// Spacing patterns (offsets from A1 for stages 2, 3, 4)
const SPACING_PATTERNS: Array<{ name: string; offsets: [number, number, number] }> = [
  { name: "A_even5",    offsets: [5, 10, 15] },
  { name: "B_even4",    offsets: [4,  8, 12] },
  { name: "C_tight",    offsets: [6, 10, 13] },
  { name: "D_wide",     offsets: [3,  7, 12] },
];

// Distance sequences [D1, D2, D3, D4]
const DIST_SEQUENCES: Array<[number, number, number, number]> = [
  [7, 4, 2, 1],
  [6, 4, 2, 1],
  [6, 3, 2, 1],
  [5, 3, 2, 1],
  [5, 3, 1, 1],
  [4, 3, 2, 1],
];

const configs: TrailConfig[] = [];

// Baselines
configs.push({ label: "No trail (baseline)", stages: [], useReentry: false });

configs.push({
  label: "Flat 30/3",
  stages: [{ activateAt: 30, distance: 3 }],
  useReentry: true,
});

configs.push({
  label: "3-stage 25/6->30/3->35/1",
  stages: [
    { activateAt: 25, distance: 6 },
    { activateAt: 30, distance: 3 },
    { activateAt: 35, distance: 1 },
  ],
  useReentry: true,
});

// 4-stage grid
for (const pattern of SPACING_PATTERNS) {
  for (const a1 of A1_VALS) {
    const [off2, off3, off4] = pattern.offsets;
    const a2 = a1 + off2;
    const a3 = a1 + off3;
    const a4 = a1 + off4;

    for (const [d1, d2, d3, d4] of DIST_SEQUENCES) {
      const label = `4S ${pattern.name} A1=${a1} D=[${d1},${d2},${d3},${d4}]`;
      configs.push({
        label,
        stages: [
          { activateAt: a1, distance: d1 },
          { activateAt: a2, distance: d2 },
          { activateAt: a3, distance: d3 },
          { activateAt: a4, distance: d4 },
        ],
        useReentry: true,
      });
    }
  }
}

console.log(`Total configs: ${configs.length} (120 grid + 3 baselines)\n`);

// --------------- position types ---------------
interface Position {
  pair: string;
  dir: "long" | "short";
  entryPrice: number;
  effectiveEP: number;
  sl: number;
  entryTime: number;
  size: number;
  peakPnlPct: number;
  isReentry: boolean;
}

interface ClosedTrade {
  pair: string;
  dir: "long" | "short";
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
  isReentry: boolean;
}

interface PendingReentry {
  pair: string;
  dir: "long" | "short";
  checkTime: number;
}

// --------------- simulation ---------------
function runSim(cfg: TrailConfig): { trades: ClosedTrade[] } {
  const openPositions: Position[]          = [];
  const closedTrades: ClosedTrade[]        = [];
  const pendingReentries: PendingReentry[] = [];

  const { stages, useReentry } = cfg;
  const hasTrail = stages.length > 0;

  function hasOpenPos(pair: string): boolean {
    return openPositions.some(p => p.pair === pair);
  }

  function closePos(idx: number, exitTime: number, rawExitPrice: number, reason: string, isSL: boolean): void {
    const pos = openPositions[idx];
    const notional = pos.size * LEV;
    const xp = applyExitPx(pos.pair, pos.dir, rawExitPrice, isSL);
    const pnl = calcPnl(pos.dir, pos.effectiveEP, xp, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir,
      entryTime: pos.entryTime, exitTime, pnl, reason,
      isReentry: pos.isReentry,
    });

    if (reason === "trail" && useReentry) {
      const checkTime = (Math.floor(exitTime / H) + 1) * H;
      pendingReentries.push({ pair: pos.pair, dir: pos.dir, checkTime });
    }

    openPositions.splice(idx, 1);
  }

  function tryOpen(pair: string, dir: "long" | "short", entryPrice: number, sl: number, t: number, isReentry: boolean): boolean {
    if (openPositions.length >= MAX_POS) return false;
    if (hasOpenPos(pair)) return false;
    const ep = applyEntryPx(pair, dir, entryPrice);
    openPositions.push({
      pair, dir, entryPrice, effectiveEP: ep, sl,
      entryTime: t, size: GARCH_SIZE, peakPnlPct: 0, isReentry,
    });
    return true;
  }

  for (let t = FULL_START; t < FULL_END; t += MIN_5) {
    const is5m = t % MIN_5 === 0;
    const is1h = t % H     === 0;

    // --- 1) SL / TP / trail checks on each 5m bar ---
    if (is5m && openPositions.length > 0) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const pd  = pairData.get(pos.pair)!;
        const bar = get5mBar(pd, t);
        if (!bar) continue;

        // SL
        if (pos.dir === "long"  && bar.l <= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }
        if (pos.dir === "short" && bar.h >= pos.sl) { closePos(pi, t, pos.sl, "sl", true); continue; }

        // TP 7%
        const tp = pos.dir === "long" ? pos.entryPrice * (1 + TP_PCT) : pos.entryPrice * (1 - TP_PCT);
        if (pos.dir === "long"  && bar.h >= tp) { closePos(pi, t, tp, "tp", false); continue; }
        if (pos.dir === "short" && bar.l <= tp) { closePos(pi, t, tp, "tp", false); continue; }

        // Peak PnL tracking (leveraged %)
        const bestPct = pos.dir === "long"
          ? (bar.h / pos.entryPrice - 1) * LEV * 100
          : (pos.entryPrice / bar.l - 1) * LEV * 100;
        if (bestPct > pos.peakPnlPct) pos.peakPnlPct = bestPct;

        // Trail logic
        if (hasTrail) {
          const dist = getTrailDistance(stages, pos.peakPnlPct);
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
      }
    }

    // --- 2) GARCH max hold (72h) exit at 1h boundary ---
    if (is1h && openPositions.length > 0) {
      for (let pi = openPositions.length - 1; pi >= 0; pi--) {
        const pos = openPositions[pi];
        const pd  = pairData.get(pos.pair)!;
        const h1Bucket = Math.floor(t / H) * H;
        const barIdx = pd.h1TsMap.get(h1Bucket);
        if (barIdx === undefined) continue;
        const bar = pd.h1[barIdx];
        if ((bar.t - pos.entryTime) / H >= MAX_HOLD_H) {
          closePos(pi, t, bar.c, "mh", false);
        }
      }
    }

    // --- 3) New GARCH entries at 1h boundary ---
    if (is1h) {
      for (const pair of PAIRS) {
        const sig = checkGarch(pair, t);
        if (sig) tryOpen(pair, sig.dir, sig.entryPrice, sig.sl, t, false);
      }
    }

    // --- 4) Pending re-entries at 1h boundary ---
    if (is1h && useReentry && pendingReentries.length > 0) {
      for (let ri = pendingReentries.length - 1; ri >= 0; ri--) {
        const re = pendingReentries[ri];
        if (t < re.checkTime) continue;
        pendingReentries.splice(ri, 1);
        const sig = checkGarchReentry(re.pair, t, re.dir);
        if (sig) tryOpen(re.pair, sig.dir, sig.entryPrice, sig.sl, t, true);
      }
    }
  }

  // Close remaining positions at end of period
  for (let pi = openPositions.length - 1; pi >= 0; pi--) {
    const pos = openPositions[pi];
    const pd  = pairData.get(pos.pair);
    if (!pd || pd.bars5m.length === 0) continue;
    const lastBar = pd.bars5m[pd.bars5m.length - 1];
    closePos(pi, FULL_END, lastBar.c, "eop", false);
  }

  return { trades: closedTrades };
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
  const rets  = [...dayPnl.values()];
  const mean  = rets.length > 0 ? rets.reduce((s, r) => s + r, 0) / rets.length : 0;
  const std   = rets.length > 1 ? Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
  const trailExits = trades.filter(t => t.reason === "trail").length;
  const reentries  = trades.filter(t => t.isReentry).length;

  return {
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    pf: gl > 0 ? gp / gl : 99,
    total,
    perDay: total / days,
    maxDD,
    sharpe,
    trailExits,
    reentries,
    trades: trades.length,
  };
}

// --------------- run all configs ---------------
interface Result {
  label: string;
  stages: TrailStage[];
  perDay: number;
  pf: number;
  wr: number;
  sharpe: number;
  maxDD: number;
  trailExits: number;
  reentries: number;
  trades: number;
  oosPerDay: number;
  oosPf: number;
  oosTrades: number;
  score: number; // $/day - (maxDD * 0.02)
}

const results: Result[] = [];

const total = configs.length;
for (let ci = 0; ci < configs.length; ci++) {
  const cfg = configs[ci];
  process.stdout.write(`[${ci + 1}/${total}] ${cfg.label}...`);

  const { trades: allTrades } = runSim(cfg);
  const fullM = computeMetrics(allTrades, FULL_START, FULL_END);
  const oosT  = allTrades.filter(t => t.entryTime >= OOS_START);
  const oosM  = computeMetrics(oosT, OOS_START, FULL_END);

  const score = fullM.perDay - fullM.maxDD * 0.02;

  results.push({
    label: cfg.label,
    stages: cfg.stages,
    perDay: fullM.perDay,
    pf: fullM.pf,
    wr: fullM.wr,
    sharpe: fullM.sharpe,
    maxDD: fullM.maxDD,
    trailExits: fullM.trailExits,
    reentries: fullM.reentries,
    trades: fullM.trades,
    oosPerDay: oosM.perDay,
    oosPf: oosM.pf,
    oosTrades: oosT.length,
    score,
  });

  process.stdout.write(` $/day=$${fullM.perDay.toFixed(3)}  MaxDD=$${fullM.maxDD.toFixed(1)}  Score=${score.toFixed(3)}\n`);
}

// Sort by combined score descending
results.sort((a, b) => b.score - a.score);

// --------------- find 3-stage reference ---------------
const ref3stage = results.find(r => r.label === "3-stage 25/6->30/3->35/1");

// --------------- print final table ---------------
const SEP  = "=".repeat(155);
const DASH = "-".repeat(155);

console.log(`\n\n${SEP}`);
console.log("4-STAGE STEPPED TRAIL EXHAUSTIVE GRID — GARCH $9 | z=4.5/3.0 | SL 3% | TP 7% | 72h | max 7 | 23 pairs | BTC 1h EMA(9/21)");
console.log(`Combined score = $/day - (MaxDD * 0.02)  |  Sorted by score descending`);
console.log(SEP);
console.log(
  "Rank".padStart(4) + "  " +
  "Config".padEnd(48) +
  "$/day".padStart(8) +
  "OOS$/d".padStart(8) +
  "PF".padStart(6) +
  "WR%".padStart(6) +
  "Sharpe".padStart(8) +
  "MaxDD".padStart(8) +
  "Score".padStart(8) +
  "Trades".padStart(7) +
  "Trail#".padStart(7) +
  "Reent#".padStart(7)
);
console.log(DASH);

// Top 20
const top20 = results.slice(0, 20);
for (let i = 0; i < top20.length; i++) {
  const r = top20[i];
  const beatsRef = ref3stage
    ? r.perDay > ref3stage.perDay && r.maxDD < ref3stage.maxDD
    : false;
  const marker = beatsRef ? " **" : "   ";
  console.log(
    String(i + 1).padStart(4) + "  " +
    (r.label + marker).padEnd(48) +
    ("$" + r.perDay.toFixed(3)).padStart(8) +
    ("$" + r.oosPerDay.toFixed(3)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    (r.wr.toFixed(1) + "%").padStart(6) +
    r.sharpe.toFixed(2).padStart(8) +
    ("$" + r.maxDD.toFixed(1)).padStart(8) +
    r.score.toFixed(3).padStart(8) +
    String(r.trades).padStart(7) +
    String(r.trailExits).padStart(7) +
    String(r.reentries).padStart(7)
  );
}

console.log(DASH);

// Print full baselines for reference
console.log("\nBaselines (full ranking position):");
const baselineLabels = ["No trail (baseline)", "Flat 30/3", "3-stage 25/6->30/3->35/1"];
for (const bl of baselineLabels) {
  const idx = results.findIndex(r => r.label === bl);
  const r = results[idx];
  if (!r) continue;
  console.log(
    `  Rank #${idx + 1}  ${r.label.padEnd(35)}` +
    `  $/day=$${r.perDay.toFixed(3)}` +
    `  OOS=$${r.oosPerDay.toFixed(3)}` +
    `  MaxDD=$${r.maxDD.toFixed(1)}` +
    `  Score=${r.score.toFixed(3)}`
  );
}

// Configs that beat 3-stage on BOTH $/day AND MaxDD
if (ref3stage) {
  const beaters = results.filter(r =>
    !baselineLabels.includes(r.label) &&
    r.perDay > ref3stage.perDay &&
    r.maxDD < ref3stage.maxDD
  );
  console.log(`\nConfigs beating 3-stage 25/6->30/3->35/1 on BOTH $/day AND MaxDD: ${beaters.length}`);
  if (beaters.length > 0) {
    for (const r of beaters.slice(0, 10)) {
      const rank = results.findIndex(x => x.label === r.label) + 1;
      console.log(
        `  Rank #${rank}  ${r.label.padEnd(48)}` +
        `  $/day=$${r.perDay.toFixed(3)} (ref $${ref3stage.perDay.toFixed(3)})` +
        `  MaxDD=$${r.maxDD.toFixed(1)} (ref $${ref3stage.maxDD.toFixed(1)})`
      );
    }
  } else {
    console.log("  None found.");
  }
}

console.log(`\n${SEP}`);
console.log(`Config: GARCH $${GARCH_SIZE} | ${PAIRS.length} pairs | 120 grid configs + 3 baselines | OOS: ${OOS_DAYS.toFixed(0)} days`);
console.log(`** = beats 3-stage 25/6->30/3->35/1 on BOTH $/day AND MaxDD`);
console.log(SEP);
