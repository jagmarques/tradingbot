/**
 * Stepped trail backtest: 4 configs compared.
 * No trail | flat 30/3 | stepped 25/6->30/3->35/1 | stepped 22/4->28/3->32/2->36/1
 * GARCH-only, $9 margin, z=4.5/3.0, SL 3%, TP 7%, 72h hold, max 7 positions.
 * 23 pairs, 2023-01 to 2026-03. OOS: 2025-09+.
 * BTC filter: 1h EMA(9/21) for GARCH.
 *
 * Run: NODE_OPTIONS="--max-old-space-size=8192" npx tsx scripts/bt-4stage-trail.ts
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

// --------------- trail modes ---------------
type TrailMode = "none" | "flat30_3" | "stepped25" | "stepped4stage";

// Stepped trail distance (leveraged %) given current peak leveraged PnL%
// stepped25: >25->6%, >30->3%, >35->1%
function steppedTrailDist25(peakPct: number): number {
  if (peakPct >= 35) return 1;
  if (peakPct >= 30) return 3;
  if (peakPct >= 25) return 6;
  return 0; // not yet activated
}

// 4-stage: >22->4%, >28->3%, >32->2%, >36->1%
function steppedTrailDist4stage(peakPct: number): number {
  if (peakPct >= 36) return 1;
  if (peakPct >= 32) return 2;
  if (peakPct >= 28) return 3;
  if (peakPct >= 22) return 4;
  return 0; // not yet activated
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
  // Cap SL
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
function runSim(trailMode: TrailMode): { trades: ClosedTrade[]; reentries: number } {
  const openPositions: Position[]          = [];
  const closedTrades: ClosedTrade[]        = [];
  const pendingReentries: PendingReentry[] = [];
  let reentryCount = 0;

  const useReentry = trailMode !== "none";

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
        if (trailMode === "flat30_3") {
          if (pos.peakPnlPct >= 30) {
            const currPct = pos.dir === "long"
              ? (bar.c / pos.entryPrice - 1) * LEV * 100
              : (pos.entryPrice / bar.c - 1) * LEV * 100;
            if (currPct <= pos.peakPnlPct - 3) { closePos(pi, t, bar.c, "trail", false); continue; }
          }
        } else if (trailMode === "stepped25") {
          const dist = steppedTrailDist25(pos.peakPnlPct);
          if (dist > 0) {
            const currPct = pos.dir === "long"
              ? (bar.c / pos.entryPrice - 1) * LEV * 100
              : (pos.entryPrice / bar.c - 1) * LEV * 100;
            if (currPct <= pos.peakPnlPct - dist) { closePos(pi, t, bar.c, "trail", false); continue; }
          }
        } else if (trailMode === "stepped4stage") {
          const dist = steppedTrailDist4stage(pos.peakPnlPct);
          if (dist > 0) {
            const currPct = pos.dir === "long"
              ? (bar.c / pos.entryPrice - 1) * LEV * 100
              : (pos.entryPrice / bar.c - 1) * LEV * 100;
            if (currPct <= pos.peakPnlPct - dist) { closePos(pi, t, bar.c, "trail", false); continue; }
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

// --------------- run 4 configs ---------------
const CONFIGS: Array<{ mode: TrailMode; label: string }> = [
  { mode: "none",          label: "No trail (baseline)" },
  { mode: "flat30_3",      label: "Flat 30/3 (current live)" },
  { mode: "stepped25",     label: "Stepped 25/6->30/3->35/1" },
  { mode: "stepped4stage", label: "Stepped 22/4->28/3->32/2->36/1" },
];

interface Result {
  label: string;
  trades: number;
  tradesPerDay: number;
  wr: number;
  perDay: number;
  pf: number;
  sharpe: number;
  maxDD: number;
  trailExits: number;
  reentries: number;
  oosPerDay: number;
  oosPf: number;
  oosWr: number;
  oosTrades: number;
}

const results: Result[] = [];

for (const { mode, label } of CONFIGS) {
  console.log(`Running: ${label}...`);
  const { trades: allTrades, reentries } = runSim(mode);

  const fullM = computeMetrics(allTrades, FULL_START, FULL_END);
  const oosT  = allTrades.filter(t => t.entryTime >= OOS_START);
  const oosM  = computeMetrics(oosT, OOS_START, FULL_END);

  results.push({
    label,
    trades:      allTrades.length,
    tradesPerDay: allTrades.length / FULL_DAYS,
    wr:          fullM.wr,
    perDay:      fullM.perDay,
    pf:          fullM.pf,
    sharpe:      fullM.sharpe,
    maxDD:       fullM.maxDD,
    trailExits:  fullM.trailExits,
    reentries:   fullM.reentries,
    oosPerDay:   oosM.perDay,
    oosPf:       oosM.pf,
    oosWr:       oosM.wr,
    oosTrades:   oosT.length,
  });

  console.log(`  Done. Trades=${allTrades.length}  $/day=$${fullM.perDay.toFixed(3)}  WR=${fullM.wr.toFixed(1)}%  PF=${fullM.pf.toFixed(2)}  Sharpe=${fullM.sharpe.toFixed(2)}  MaxDD=$${fullM.maxDD.toFixed(1)}  OOS=$${oosM.perDay.toFixed(3)}`);
}

// --------------- print final table ---------------
const SEP  = "=".repeat(135);
const DASH = "-".repeat(135);

console.log(`\n\n${SEP}`);
console.log("4-STAGE STEPPED TRAIL BACKTEST — GARCH-only $9 | z=4.5/3.0 | SL 3% | TP 7% | 72h | max 7 | 23 pairs | 2023-01 to 2026-03");
console.log(SEP);
console.log(
  "Config".padEnd(38) +
  "Trades".padStart(7) +
  "T/day".padStart(6) +
  "WR%".padStart(7) +
  "$/day".padStart(9) +
  "PF".padStart(7) +
  "Sharpe".padStart(8) +
  "MaxDD".padStart(9) +
  "Trail#".padStart(7) +
  "Reent#".padStart(7) +
  "OOS$/d".padStart(9) +
  "OOSPF".padStart(7) +
  "OOSTrd".padStart(7)
);
console.log(DASH);

for (const r of results) {
  console.log(
    r.label.padEnd(38) +
    String(r.trades).padStart(7) +
    r.tradesPerDay.toFixed(2).padStart(6) +
    (r.wr.toFixed(1) + "%").padStart(7) +
    ("$" + r.perDay.toFixed(3)).padStart(9) +
    r.pf.toFixed(2).padStart(7) +
    r.sharpe.toFixed(2).padStart(8) +
    ("$" + r.maxDD.toFixed(1)).padStart(9) +
    String(r.trailExits).padStart(7) +
    String(r.reentries).padStart(7) +
    ("$" + r.oosPerDay.toFixed(3)).padStart(9) +
    r.oosPf.toFixed(2).padStart(7) +
    String(r.oosTrades).padStart(7)
  );
}

console.log(DASH);

// Delta vs baseline
const baseline = results[0];
console.log("\nDelta vs no-trail baseline:");
for (const r of results.slice(1)) {
  const dPerDay = r.perDay - baseline.perDay;
  const dOos    = r.oosPerDay - baseline.oosPerDay;
  const dDD     = r.maxDD - baseline.maxDD;
  console.log(
    `  ${r.label.padEnd(36)}  $/day ${dPerDay >= 0 ? "+" : ""}${dPerDay.toFixed(3)}` +
    `  OOS ${dOos >= 0 ? "+" : ""}${dOos.toFixed(3)}` +
    `  MaxDD ${dDD >= 0 ? "+" : ""}${dDD.toFixed(1)}`
  );
}

// Each trail vs flat 30/3
const flat = results[1];
console.log("\nVs flat 30/3 (current live):");
for (const r of results.slice(2)) {
  const dPerDay = r.perDay - flat.perDay;
  const dOos    = r.oosPerDay - flat.oosPerDay;
  const dDD     = r.maxDD - flat.maxDD;
  console.log(
    `  ${r.label.padEnd(36)}  $/day ${dPerDay >= 0 ? "+" : ""}${dPerDay.toFixed(3)}` +
    `  OOS ${dOos >= 0 ? "+" : ""}${dOos.toFixed(3)}` +
    `  MaxDD ${dDD >= 0 ? "+" : ""}${dDD.toFixed(1)}` +
    `  Trail# ${r.trailExits} vs ${flat.trailExits}`
  );
}

console.log(`\n${SEP}`);
console.log(`Config: GARCH $${GARCH_SIZE} margin (notional $${GARCH_SIZE * LEV})  |  ${PAIRS.length} pairs  |  BTC filter: 1h EMA(9/21)  |  OOS period: ${OOS_DAYS.toFixed(0)} days`);
console.log(SEP);
