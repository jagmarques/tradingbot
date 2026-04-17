/**
 * Dense 4-stage stepped trail search — novel patterns not covered before.
 * GARCH-only, $9 margin, z=4.5/3.0, SL 3%, TP 7%, 72h hold, max 7 positions.
 * 23 pairs, 2023-01 to 2026-03. OOS: 2025-09+.
 * BTC filter: 1h EMA(9/21) for GARCH.
 * Score = $/day - (MaxDD * 0.02). Benchmark: 3-stage 25/6->30/3->35/1 score 0.895.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-4stage-dense.ts
 */

import * as fs from "fs";
import * as path from "path";

interface C { t: number; o: number; h: number; l: number; c: number; }

const CD_5M   = "/tmp/bt-pair-cache-5m";
const H       = 3_600_000;
const H4      = 4 * H;
const D       = 86_400_000;
const MIN_5   = 5 * 60_000;
const FEE     = 0.000_35;
const SL_SLIP = 1.5;
const LEV     = 10;

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
  const h1Z    = computeZScores(h1, 3, 20);
  const h1Ema9 = calcEMA(h1Closes, 9);
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

// --------------- trail config types ---------------

// A stage: if peakPnlPct >= threshold, trail distance = dist
// Stages should be ordered ascending by threshold
interface TrailStage { threshold: number; dist: number; }

type TrailConfig =
  | { type: "none" }
  | { type: "flat"; threshold: number; dist: number }
  | { type: "staged"; stages: TrailStage[] };  // stages sorted ascending threshold

function getTrailDist(cfg: TrailConfig, peakPct: number): number {
  if (cfg.type === "none") return 0;
  if (cfg.type === "flat") {
    return peakPct >= cfg.threshold ? cfg.dist : 0;
  }
  // staged: find highest threshold we've crossed
  let dist = 0;
  for (const s of cfg.stages) {
    if (peakPct >= s.threshold) dist = s.dist;
  }
  return dist;
}

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

// --------------- simulation ---------------
function runSim(trailCfg: TrailConfig): { trades: ClosedTrade[]; reentries: number } {
  const openPositions: Position[]          = [];
  const closedTrades: ClosedTrade[]        = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;

  const useReentry = trailCfg.type !== "none";

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
    if (isReentry) reentryCount++;
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
        const dist = getTrailDist(trailCfg, pos.peakPnlPct);
        if (dist > 0) {
          const currPct = pos.dir === "long"
            ? (bar.c / pos.entryPrice - 1) * LEV * 100
            : (pos.entryPrice / bar.c - 1) * LEV * 100;
          if (currPct <= pos.peakPnlPct - dist) { closePos(pi, t, bar.c, "trail", false); continue; }
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

  return { trades: closedTrades, reentries: reentryCount };
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
  };
}

// --------------- config definitions ---------------
interface ConfigDef {
  label: string;
  cfg: TrailConfig;
  set: string;
}

const CONFIGS: ConfigDef[] = [
  // --- References ---
  {
    label: "REF: No trail",
    set: "ref",
    cfg: { type: "none" },
  },
  {
    label: "REF: Flat 30/3",
    set: "ref",
    cfg: { type: "flat", threshold: 30, dist: 3 },
  },
  {
    label: "REF: 3-stage 25/6->30/3->35/1",
    set: "ref",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 6 }, { threshold: 30, dist: 3 }, { threshold: 35, dist: 1 }] },
  },

  // --- SET 1: Asymmetric spacing ---
  {
    label: "S1a 20/7->25/4->35/2->45/1",
    set: "set1",
    cfg: { type: "staged", stages: [{ threshold: 20, dist: 7 }, { threshold: 25, dist: 4 }, { threshold: 35, dist: 2 }, { threshold: 45, dist: 1 }] },
  },
  {
    label: "S1b 20/6->27/3->37/2->47/1",
    set: "set1",
    cfg: { type: "staged", stages: [{ threshold: 20, dist: 6 }, { threshold: 27, dist: 3 }, { threshold: 37, dist: 2 }, { threshold: 47, dist: 1 }] },
  },
  {
    label: "S1c 22/7->28/4->38/1->48/1",
    set: "set1",
    cfg: { type: "staged", stages: [{ threshold: 22, dist: 7 }, { threshold: 28, dist: 4 }, { threshold: 38, dist: 1 }, { threshold: 48, dist: 1 }] },
  },
  {
    label: "S1d 18/7->25/4->33/2->40/1",
    set: "set1",
    cfg: { type: "staged", stages: [{ threshold: 18, dist: 7 }, { threshold: 25, dist: 4 }, { threshold: 33, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S1e 23/6->28/3->35/1->45/1",
    set: "set1",
    cfg: { type: "staged", stages: [{ threshold: 23, dist: 6 }, { threshold: 28, dist: 3 }, { threshold: 35, dist: 1 }, { threshold: 45, dist: 1 }] },
  },

  // --- SET 2: Wide first stage, tight last stages ---
  {
    label: "S2a 25/8->32/3->37/1->42/1",
    set: "set2",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 8 }, { threshold: 32, dist: 3 }, { threshold: 37, dist: 1 }, { threshold: 42, dist: 1 }] },
  },
  {
    label: "S2b 25/7->30/3->34/1->38/1",
    set: "set2",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 7 }, { threshold: 30, dist: 3 }, { threshold: 34, dist: 1 }, { threshold: 38, dist: 1 }] },
  },
  {
    label: "S2c 25/7->31/4->36/2->40/1",
    set: "set2",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 7 }, { threshold: 31, dist: 4 }, { threshold: 36, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S2d 22/8->30/4->36/2->42/1",
    set: "set2",
    cfg: { type: "staged", stages: [{ threshold: 22, dist: 8 }, { threshold: 30, dist: 4 }, { threshold: 36, dist: 2 }, { threshold: 42, dist: 1 }] },
  },
  {
    label: "S2e 20/8->28/3->34/2->40/1",
    set: "set2",
    cfg: { type: "staged", stages: [{ threshold: 20, dist: 8 }, { threshold: 28, dist: 3 }, { threshold: 34, dist: 2 }, { threshold: 40, dist: 1 }] },
  },

  // --- SET 3: Very loose start, aggressive lock ---
  {
    label: "S3a 30/7->34/3->37/2->40/1",
    set: "set3",
    cfg: { type: "staged", stages: [{ threshold: 30, dist: 7 }, { threshold: 34, dist: 3 }, { threshold: 37, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S3b 28/7->32/4->36/2->40/1",
    set: "set3",
    cfg: { type: "staged", stages: [{ threshold: 28, dist: 7 }, { threshold: 32, dist: 4 }, { threshold: 36, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S3c 27/6->31/3->35/2->39/1",
    set: "set3",
    cfg: { type: "staged", stages: [{ threshold: 27, dist: 6 }, { threshold: 31, dist: 3 }, { threshold: 35, dist: 2 }, { threshold: 39, dist: 1 }] },
  },
  {
    label: "S3d 25/6->29/3->33/2->37/1",
    set: "set3",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 6 }, { threshold: 29, dist: 3 }, { threshold: 33, dist: 2 }, { threshold: 37, dist: 1 }] },
  },
  {
    label: "S3e 26/7->30/4->34/2->38/1",
    set: "set3",
    cfg: { type: "staged", stages: [{ threshold: 26, dist: 7 }, { threshold: 30, dist: 4 }, { threshold: 34, dist: 2 }, { threshold: 38, dist: 1 }] },
  },

  // --- SET 4: Non-standard distances ---
  {
    label: "S4a 25/5->30/3->35/2->40/1",
    set: "set4",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 5 }, { threshold: 30, dist: 3 }, { threshold: 35, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S4b 25/5->30/4->35/2->40/1",
    set: "set4",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 5 }, { threshold: 30, dist: 4 }, { threshold: 35, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S4c 25/6->30/3->35/2->40/1",
    set: "set4",
    cfg: { type: "staged", stages: [{ threshold: 25, dist: 6 }, { threshold: 30, dist: 3 }, { threshold: 35, dist: 2 }, { threshold: 40, dist: 1 }] },
  },
  {
    label: "S4d 23/6->28/4->33/2->38/1",
    set: "set4",
    cfg: { type: "staged", stages: [{ threshold: 23, dist: 6 }, { threshold: 28, dist: 4 }, { threshold: 33, dist: 2 }, { threshold: 38, dist: 1 }] },
  },
  {
    label: "S4e 24/5->29/3->34/2->39/1",
    set: "set4",
    cfg: { type: "staged", stages: [{ threshold: 24, dist: 5 }, { threshold: 29, dist: 3 }, { threshold: 34, dist: 2 }, { threshold: 39, dist: 1 }] },
  },
];

// --------------- run all configs ---------------
interface Result {
  label: string;
  set: string;
  trades: number;
  tradesPerDay: number;
  wr: number;
  perDay: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  score: number;
  trailExits: number;
  reentries: number;
  oosPerDay: number;
  oosPf: number;
  oosWr: number;
  oosTrades: number;
}

const results: Result[] = [];

for (const { cfg, label, set } of CONFIGS) {
  process.stdout.write(`Running: ${label}...`);
  const { trades: allTrades } = runSim(cfg);

  const fullM = computeMetrics(allTrades, FULL_START, FULL_END);
  const oosT  = allTrades.filter(t => t.entryTime >= OOS_START);
  const oosM  = computeMetrics(oosT, OOS_START, FULL_END);
  const score = fullM.perDay - fullM.maxDD * 0.02;

  results.push({
    label, set,
    trades:      allTrades.length,
    tradesPerDay: allTrades.length / FULL_DAYS,
    wr:          fullM.wr,
    perDay:      fullM.perDay,
    pf:          fullM.pf,
    sharpe:      fullM.sharpe,
    maxDD:       fullM.maxDD,
    score,
    trailExits:  fullM.trailExits,
    reentries:   fullM.reentries,
    oosPerDay:   oosM.perDay,
    oosPf:       oosM.pf,
    oosWr:       oosM.wr,
    oosTrades:   oosT.length,
  });

  process.stdout.write(` $/day=$${fullM.perDay.toFixed(3)}  MaxDD=$${fullM.maxDD.toFixed(1)}  Score=${score.toFixed(3)}  OOS=$${oosM.perDay.toFixed(3)}\n`);
}

// --------------- print final table ---------------
const BENCHMARK_SCORE = 0.895;
const BENCHMARK_LABEL = "REF: 3-stage 25/6->30/3->35/1";

const SEP  = "=".repeat(160);
const DASH = "-".repeat(160);

console.log(`\n\n${SEP}`);
console.log("DENSE 4-STAGE TRAIL BACKTEST — GARCH $9 | z=4.5/3.0 | SL 3% | TP 7% | 72h | max 7 | 23 pairs | BTC 1h EMA(9/21)");
console.log(`Score = $/day - MaxDD*0.02  |  Benchmark (3-stage 25/6->30/3->35/1): ${BENCHMARK_SCORE}`);
console.log(SEP);
console.log(
  "Config".padEnd(38) +
  "Set".padStart(5) +
  "Trd".padStart(5) +
  "WR%".padStart(6) +
  "$/day".padStart(8) +
  "PF".padStart(6) +
  "Shrp".padStart(6) +
  "MaxDD".padStart(8) +
  "Score".padStart(7) +
  "Trail#".padStart(7) +
  "Rent#".padStart(6) +
  "OOS$/d".padStart(8) +
  "OOSTrd".padStart(7) +
  "BEAT?".padStart(7)
);
console.log(DASH);

const refResult = results.find(r => r.label === BENCHMARK_LABEL);
const refScore  = refResult?.score ?? BENCHMARK_SCORE;

for (const r of results) {
  const beats = r.score > refScore && r.label !== BENCHMARK_LABEL;
  const beatsMark = beats ? " ***" : "";
  console.log(
    r.label.padEnd(38) +
    r.set.padStart(5) +
    String(r.trades).padStart(5) +
    (r.wr.toFixed(1) + "%").padStart(6) +
    ("$" + r.perDay.toFixed(3)).padStart(8) +
    r.pf.toFixed(2).padStart(6) +
    r.sharpe.toFixed(2).padStart(6) +
    ("$" + r.maxDD.toFixed(1)).padStart(8) +
    r.score.toFixed(3).padStart(7) +
    String(r.trailExits).padStart(7) +
    String(r.reentries).padStart(6) +
    ("$" + r.oosPerDay.toFixed(3)).padStart(8) +
    String(r.oosTrades).padStart(7) +
    (beats ? "  ***BEATS***" : "")
  );
}

console.log(DASH);

// Sort by score, show top 5
const sorted = [...results]
  .filter(r => r.set !== "ref")
  .sort((a, b) => b.score - a.score);

console.log("\nTOP 5 novel configs by score:");
for (const r of sorted.slice(0, 5)) {
  const delta = r.score - refScore;
  console.log(
    `  ${r.label.padEnd(36)}  Score=${r.score.toFixed(3)}  Delta=${delta >= 0 ? "+" : ""}${delta.toFixed(3)}  $/day=$${r.perDay.toFixed(3)}  MaxDD=$${r.maxDD.toFixed(1)}  OOS=$${r.oosPerDay.toFixed(3)}`
  );
}

// Configs that beat benchmark
const beaters = results.filter(r => r.score > refScore && r.label !== BENCHMARK_LABEL);
if (beaters.length > 0) {
  console.log(`\n*** ${beaters.length} config(s) beat benchmark score ${refScore}: ***`);
  for (const r of beaters.sort((a, b) => b.score - a.score)) {
    const delta = r.score - refScore;
    console.log(
      `  ${r.label.padEnd(36)}  Score=${r.score.toFixed(3)} (+${delta.toFixed(3)})  $/day=$${r.perDay.toFixed(3)}  MaxDD=$${r.maxDD.toFixed(1)}  PF=${r.pf.toFixed(2)}  Shrp=${r.sharpe.toFixed(2)}  OOS=$${r.oosPerDay.toFixed(3)}`
    );
  }
} else {
  console.log(`\nNo novel configs beat benchmark score ${refScore}.`);
}

console.log(`\n${SEP}`);
console.log(`Config: GARCH $${GARCH_SIZE} (notional $${GARCH_SIZE * LEV}) | ${PAIRS.length} pairs | BTC filter: 1h EMA(9/21) | OOS: ${OOS_DAYS.toFixed(0)} days`);
console.log(SEP);
