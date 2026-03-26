/**
 * Devil's Advocate: GARCH v2 Stress Test
 *
 * Systematically tries to BREAK the strategy by testing for:
 * 1. Direction bias (long-only vs short-only)
 * 2. Spread sensitivity (2x, 3x spreads)
 * 3. Entry slippage sensitivity (0.1%, 0.2%, 0.5%)
 * 4. Parameter sensitivity (z-threshold sweep)
 * 5. Filter ablation (remove each filter)
 * 6. Regime split (6-month chunks)
 * 7. Max hold sensitivity (12h..168h)
 * 8. SL/TP sensitivity grid
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-critic.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA } from "technicalindicators";

// ─── Types ──────────────────────────────────────────────────────────

interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface Position {
  pair: string; direction: "long" | "short";
  entryPrice: number; entryTime: number;
  stopLoss: number; takeProfit: number;
}
interface Trade {
  pair: string; direction: "long" | "short";
  entryPrice: number; exitPrice: number;
  entryTime: number; exitTime: number;
  pnl: number; reason: string;
}
interface PairData {
  candles: Candle[];
  tsMap: Map<number, number>;
  zScores: number[];
  adx14: Array<{ adx: number; pdi: number; mdi: number }>;
  ema9: number[];
  ema21: number[];
  atr14: number[];
}

// ─── Constants ──────────────────────────────────────────────────────

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const D = 86_400_000;
const FEE = 0.000_35;
const SIZE = 10;
const LEV = 10;
const NOT = SIZE * LEV;

// GARCH v2 exact params
const Z_LONG = 4.5;
const Z_SHORT = -3.0;
const MOM_LB = 3;
const VOL_WIN = 20;
const ADX_LONG_MIN = 30;
const ADX_SHORT_MIN = 25;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const ATR_PERIOD = 14;
const VOL_LB = 5;
const VOL_RATIO = 0.9;
const SL_PCT = 0.03;
const TP_PCT = 0.10;
const MAX_HOLD_BARS = 48;
const MAX_PER_DIR = 6;
const SL_SLIP = 1.5;

const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4,
  DOTUSDT: 4.95e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  BTCUSDT: 0.5e-4, SOLUSDT: 2.0e-4,
};

const PAIRS = [
  "OPUSDT", "ARBUSDT", "LDOUSDT", "TRUMPUSDT", "DOTUSDT", "ENAUSDT",
  "DOGEUSDT", "APTUSDT", "LINKUSDT", "ADAUSDT", "WLDUSDT", "XRPUSDT",
  "SOLUSDT",
];

const FULL_START = new Date("2023-06-01").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const OOS_END = new Date("2026-03-26").getTime();

// ─── Data Loading ───────────────────────────────────────────────────

function load5m(filename: string): Candle[] {
  const fp = path.join(CACHE_5M, filename + ".json");
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as unknown[];
  return (raw as (number[] | Record<string, number>)[]).map(b => {
    if (Array.isArray(b)) return { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] };
    return { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c };
  });
}

function aggregate1h(bars5m: Candle[]): Candle[] {
  const groups = new Map<number, Candle[]>();
  for (const b of bars5m) {
    const hourTs = Math.floor(b.t / H) * H;
    let arr = groups.get(hourTs);
    if (!arr) { arr = []; groups.set(hourTs, arr); }
    arr.push(b);
  }
  const result: Candle[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < 10) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicator Helpers ──────────────────────────────────────────────

function getVal(arr: number[], barIdx: number, candleLen: number): number | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

function getAdx(arr: Array<{ adx: number; pdi: number; mdi: number }>, barIdx: number, candleLen: number): { adx: number } | null {
  const offset = candleLen - arr.length;
  const idx = barIdx - offset;
  if (idx < 0 || idx >= arr.length) return null;
  return arr[idx];
}

// ─── Precompute ─────────────────────────────────────────────────────

function precompute(filename: string): PairData | null {
  const bars5m = load5m(filename);
  if (bars5m.length < 200) return null;
  const candles = aggregate1h(bars5m);
  if (candles.length < 200) return null;

  const tsMap = new Map<number, number>();
  candles.forEach((c, i) => tsMap.set(c.t, i));

  const closes = candles.map(c => c.c);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);

  const ema9 = EMA.calculate({ period: EMA_FAST, values: closes });
  const ema21 = EMA.calculate({ period: EMA_SLOW, values: closes });
  const atr14 = ATR.calculate({ period: ATR_PERIOD, high: highs, low: lows, close: closes });
  const adx14 = ADX.calculate({ period: 14, high: highs, low: lows, close: closes });

  const zScores = new Array(candles.length).fill(0);
  for (let i = Math.max(MOM_LB + 1, VOL_WIN + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - MOM_LB].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - VOL_WIN + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
      sumSq += r * r;
      count++;
    }
    if (count < 10) continue;
    const vol = Math.sqrt(sumSq / count);
    if (vol === 0) continue;
    zScores[i] = mom / vol;
  }

  return { candles, tsMap, zScores, adx14, ema9, ema21, atr14 };
}

// ─── Filter flags for ablation ──────────────────────────────────────

interface FilterFlags {
  useAdx: boolean;
  useEma: boolean;
  useBtc: boolean;
  useAtr: boolean;
}

const ALL_FILTERS: FilterFlags = { useAdx: true, useEma: true, useBtc: true, useAtr: true };

// ─── GARCH Signal ───────────────────────────────────────────────────

function garchSignal(
  pd: PairData, barIdx: number, btcPd: PairData, pairTs: number,
  zLong: number, zShort: number, filters: FilterFlags,
): "long" | "short" | null {
  const prev = barIdx - 1;
  if (prev < VOL_WIN + MOM_LB) return null;

  const z = pd.zScores[prev];
  if (isNaN(z) || z === 0) return null;

  const goLong = z > zLong;
  const goShort = z < zShort;
  if (!goLong && !goShort) return null;

  // ADX filter
  if (filters.useAdx) {
    const adx = getAdx(pd.adx14, prev, pd.candles.length);
    if (!adx) return null;
    if (goLong && adx.adx < ADX_LONG_MIN) return null;
    if (goShort && adx.adx < ADX_SHORT_MIN) return null;
  }

  // EMA 9/21 trend filter
  if (filters.useEma) {
    const e9 = getVal(pd.ema9, prev, pd.candles.length);
    const e21 = getVal(pd.ema21, prev, pd.candles.length);
    if (e9 === null || e21 === null) return null;
    if (goLong && e9 <= e21) return null;
    if (goShort && e9 >= e21) return null;
  }

  // ATR vol filter
  if (filters.useAtr) {
    const atrNow = getVal(pd.atr14, prev, pd.candles.length);
    const atrOld = getVal(pd.atr14, prev - VOL_LB, pd.candles.length);
    if (atrNow === null || atrOld === null) return null;
    if (atrNow < VOL_RATIO * atrOld) return null;
  }

  // BTC regime filter
  if (filters.useBtc) {
    const btcIdx = btcPd.tsMap.get(pairTs);
    if (btcIdx === undefined || btcIdx < 1) return null;
    const btcPrev = btcIdx - 1;
    const be9 = getVal(btcPd.ema9, btcPrev, btcPd.candles.length);
    const be21 = getVal(btcPd.ema21, btcPrev, btcPd.candles.length);
    if (be9 === null || be21 === null) return null;
    const btcTrend = be9 > be21 ? "long" : "short";
    if (goLong && btcTrend !== "long") return null;
    if (goShort && btcTrend !== "short") return null;
  }

  return goLong ? "long" : "short";
}

// ─── Simulation Engine ──────────────────────────────────────────────

interface SimOpts {
  startTs: number; endTs: number;
  dirFilter?: "both" | "long" | "short";
  spreadMult?: number;
  entrySlipPct?: number;
  maxHoldBars?: number;
  slPct?: number;
  tpPct?: number;
  zLong?: number;
  zShort?: number;
  filters?: FilterFlags;
}

function simulate(
  pdm: Map<string, PairData>, btcPd: PairData, pairs: string[], opts: SimOpts,
): Trade[] {
  const {
    startTs, endTs,
    dirFilter = "both",
    spreadMult = 1,
    entrySlipPct = 0,
    maxHoldBars: mh = MAX_HOLD_BARS,
    slPct = SL_PCT,
    tpPct = TP_PCT,
    zLong: zL = Z_LONG,
    zShort: zS = Z_SHORT,
    filters = ALL_FILTERS,
  } = opts;

  const pd = new Map<string, PairData>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);

  const open = new Map<string, Position>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // --- EXITS ---
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.candles[bi];
      const sp = (SP[p] ?? 4e-4) * spreadMult;

      let exitPrice = 0;
      let reason = "";

      // SL
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP);
        reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP);
        reason = "sl";
      }

      // TP
      if (!reason) {
        if (pos.direction === "long" && bar.h >= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 - sp);
          reason = "tp";
        } else if (pos.direction === "short" && bar.l <= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 + sp);
          reason = "tp";
        }
      }

      // Max hold
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (mh > 0 && barsHeld >= mh) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = NOT * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOT
          : (pos.entryPrice / exitPrice - 1) * NOT;
        trades.push({
          pair: p, direction: pos.direction,
          entryPrice: pos.entryPrice, exitPrice,
          entryTime: pos.entryTime, exitTime: ts,
          pnl: raw - fee, reason,
        });
        open.delete(p);
        closedThisBar.add(p);
      }
    }

    // --- ENTRIES ---
    for (const [p, d] of pd) {
      if (open.has(p) || closedThisBar.has(p)) continue;
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 60) continue;

      const dir = garchSignal(d, bi, btcPd, ts, zL, zS, filters);
      if (!dir) continue;
      if (dirFilter !== "both" && dir !== dirFilter) continue;

      const dirCount = [...open.values()].filter(x => x.direction === dir).length;
      if (dirCount >= MAX_PER_DIR) continue;

      const entryRaw = d.candles[bi].o;
      const sp = (SP[p] ?? 4e-4) * spreadMult;
      const slip = entrySlipPct / 100;
      const entry = dir === "long"
        ? entryRaw * (1 + sp) * (1 + slip)
        : entryRaw * (1 - sp) * (1 - slip);
      const sl = dir === "long" ? entry * (1 - slPct) : entry * (1 + slPct);
      const tp = dir === "long" ? entry * (1 + tpPct) : entry * (1 - tpPct);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl, takeProfit: tp });
    }
  }

  return trades;
}

// ─── Stats Helper ───────────────────────────────────────────────────

interface Stats {
  n: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxDD: number;
  sharpe: number;
  profitFactor: number;
  dailyPnl: number;
  longs: number;
  shorts: number;
}

function calcStats(trades: Trade[], startTs: number, endTs: number): Stats {
  const n = trades.length;
  if (n === 0) return { n: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, maxDD: 0, sharpe: 0, profitFactor: 0, dailyPnl: 0, longs: 0, shorts: 0 };

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 999 : 0;

  // Max drawdown
  let peak = 0, eq = 0, maxDD = 0;
  for (const t of trades.sort((a, b) => a.exitTime - b.exitTime)) {
    eq += t.pnl;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  // Daily Sharpe
  const dayMap = new Map<number, number>();
  for (const t of trades) {
    const dk = Math.floor(t.exitTime / D) * D;
    dayMap.set(dk, (dayMap.get(dk) ?? 0) + t.pnl);
  }
  const dailyPnls = [...dayMap.values()];
  const mean = dailyPnls.length > 0 ? dailyPnls.reduce((s, v) => s + v, 0) / dailyPnls.length : 0;
  const variance = dailyPnls.length > 1 ? dailyPnls.reduce((s, v) => s + (v - mean) ** 2, 0) / (dailyPnls.length - 1) : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(365) : 0;

  const days = (endTs - startTs) / D;
  const dailyPnl = totalPnl / Math.max(1, days);

  const longs = trades.filter(t => t.direction === "long").length;
  const shorts = trades.filter(t => t.direction === "short").length;

  return {
    n, wins, losses,
    winRate: n > 0 ? wins / n * 100 : 0,
    totalPnl, avgPnl: totalPnl / n,
    maxDD, sharpe, profitFactor: pf,
    dailyPnl, longs, shorts,
  };
}

function fmt(n: number, d = 2): string { return n.toFixed(d); }
function fmtS(s: Stats): string {
  return `N=${s.n} WR=${fmt(s.winRate)}% PnL=$${fmt(s.totalPnl)} Avg=$${fmt(s.avgPnl)} PF=${fmt(s.profitFactor)} DD=$${fmt(s.maxDD)} Sharpe=${fmt(s.sharpe)} $/d=$${fmt(s.dailyPnl)}`;
}

function verdict(totalPnl: number, baseline: number, label: string): string {
  if (totalPnl <= 0) return "FAIL";
  if (totalPnl < baseline * 0.5) return "WARNING";
  return "PASS";
}

// ─── Main ───────────────────────────────────────────────────────────

function main() {
  console.log("=".repeat(80));
  console.log("  GARCH v2 DEVIL'S ADVOCATE -- Trying to BREAK the strategy");
  console.log("=".repeat(80));
  console.log();

  // Load data
  console.log("[Loading] 5m candles -> 1h aggregation...");
  const pdm = new Map<string, PairData>();
  for (const p of [...PAIRS, "BTCUSDT"]) {
    const pd = precompute(p);
    if (pd) {
      pdm.set(p, pd);
      console.log(`  ${p}: ${pd.candles.length} 1h bars (${new Date(pd.candles[0].t).toISOString().slice(0, 10)} to ${new Date(pd.candles[pd.candles.length - 1].t).toISOString().slice(0, 10)})`);
    } else {
      console.log(`  ${p}: MISSING`);
    }
  }
  const btcPd = pdm.get("BTCUSDT");
  if (!btcPd) { console.log("FATAL: No BTC data"); return; }
  console.log();

  // ─── BASELINE ─────────────────────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  BASELINE (exact v2 params)");
  console.log("=".repeat(80));

  const fullTrades = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END });
  const fullStats = calcStats(fullTrades, FULL_START, OOS_END);
  console.log(`  FULL : ${fmtS(fullStats)} (L=${fullStats.longs} S=${fullStats.shorts})`);

  const oosTrades = simulate(pdm, btcPd, PAIRS, { startTs: OOS_START, endTs: OOS_END });
  const oosStats = calcStats(oosTrades, OOS_START, OOS_END);
  console.log(`  OOS  : ${fmtS(oosStats)} (L=${oosStats.longs} S=${oosStats.shorts})`);

  const baselineFull = fullStats.totalPnl;
  const baselineOos = oosStats.totalPnl;

  // Exit reason breakdown
  const reasons = new Map<string, number>();
  for (const t of fullTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
  console.log(`  Exit reasons: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log();

  // ─── TEST 1: DIRECTION BIAS ───────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 1: DIRECTION BIAS");
  console.log("  If only one side profits, it's a market regime artifact");
  console.log("=".repeat(80));

  for (const period of [{ name: "FULL", s: FULL_START, e: OOS_END }, { name: "OOS", s: OOS_START, e: OOS_END }]) {
    for (const dir of ["long", "short"] as const) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: period.s, endTs: period.e, dirFilter: dir });
      const st = calcStats(tr, period.s, period.e);
      const v = st.totalPnl > 0 ? "PASS" : "FAIL";
      console.log(`  ${period.name} ${dir.toUpperCase().padEnd(5)}: ${fmtS(st)} -> ${v}`);
    }
  }

  // Overall verdict for direction bias
  const fullLong = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, dirFilter: "long" });
  const fullShort = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, dirFilter: "short" });
  const longPnl = fullLong.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = fullShort.reduce((s, t) => s + t.pnl, 0);
  const biasRatio = Math.min(Math.abs(longPnl), Math.abs(shortPnl)) / Math.max(Math.abs(longPnl), Math.abs(shortPnl), 0.01);
  const biasV = longPnl > 0 && shortPnl > 0 ? "PASS" : (longPnl + shortPnl > 0 ? "WARNING" : "FAIL");
  console.log(`  Bias ratio: ${fmt(biasRatio * 100)}% (>30% = balanced). Verdict: ${biasV}`);
  console.log();

  // ─── TEST 2: SPREAD SENSITIVITY ───────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 2: SPREAD SENSITIVITY");
  console.log("  At what spread multiplier does the strategy break?");
  console.log("=".repeat(80));

  for (const mult of [1, 1.5, 2, 2.5, 3, 4, 5]) {
    const tr = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, spreadMult: mult });
    const st = calcStats(tr, FULL_START, OOS_END);
    const v = st.totalPnl > 0 ? (st.totalPnl > baselineFull * 0.5 ? "PASS" : "WARNING") : "FAIL";
    console.log(`  ${mult}x spread: ${fmtS(st)} -> ${v}`);
  }

  // OOS spread sensitivity
  for (const mult of [2, 3]) {
    const tr = simulate(pdm, btcPd, PAIRS, { startTs: OOS_START, endTs: OOS_END, spreadMult: mult });
    const st = calcStats(tr, OOS_START, OOS_END);
    const v = st.totalPnl > 0 ? "PASS" : "FAIL";
    console.log(`  OOS ${mult}x spread: ${fmtS(st)} -> ${v}`);
  }
  console.log();

  // ─── TEST 3: ENTRY SLIPPAGE ───────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 3: ENTRY SLIPPAGE SENSITIVITY");
  console.log("  Adverse slippage on every entry");
  console.log("=".repeat(80));

  for (const slip of [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5]) {
    const tr = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, entrySlipPct: slip });
    const st = calcStats(tr, FULL_START, OOS_END);
    const v = st.totalPnl > 0 ? (st.totalPnl > baselineFull * 0.5 ? "PASS" : "WARNING") : "FAIL";
    console.log(`  ${fmt(slip, 2)}% slip: ${fmtS(st)} -> ${v}`);
  }

  // OOS slippage
  for (const slip of [0.1, 0.2, 0.5]) {
    const tr = simulate(pdm, btcPd, PAIRS, { startTs: OOS_START, endTs: OOS_END, entrySlipPct: slip });
    const st = calcStats(tr, OOS_START, OOS_END);
    const v = st.totalPnl > 0 ? "PASS" : "FAIL";
    console.log(`  OOS ${fmt(slip, 2)}% slip: ${fmtS(st)} -> ${v}`);
  }
  console.log();

  // ─── TEST 4: Z-THRESHOLD PARAMETER SENSITIVITY ────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 4: Z-THRESHOLD PARAMETER SENSITIVITY");
  console.log("  Is z=4.5/-3.0 a fragile peak or robust plateau?");
  console.log("=".repeat(80));

  const zLongs = [3.5, 4.0, 4.5, 5.0, 5.5];
  const zShorts = [-2.0, -2.5, -3.0, -3.5, -4.0];

  console.log("  FULL PERIOD grid (z-long rows, z-short cols):");
  console.log(`  ${"".padEnd(8)}${zShorts.map(z => String(z).padStart(10)).join("")}`);
  const gridFull: number[][] = [];
  for (const zl of zLongs) {
    const row: number[] = [];
    let line = `  ${String(zl).padStart(6)}  `;
    for (const zs of zShorts) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, zLong: zl, zShort: zs });
      const st = calcStats(tr, FULL_START, OOS_END);
      row.push(st.totalPnl);
      line += `${("$" + fmt(st.totalPnl)).padStart(10)}`;
    }
    gridFull.push(row);
    console.log(line);
  }

  console.log();
  console.log("  OOS PERIOD grid:");
  console.log(`  ${"".padEnd(8)}${zShorts.map(z => String(z).padStart(10)).join("")}`);
  const gridOos: number[][] = [];
  for (const zl of zLongs) {
    const row: number[] = [];
    let line = `  ${String(zl).padStart(6)}  `;
    for (const zs of zShorts) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: OOS_START, endTs: OOS_END, zLong: zl, zShort: zs });
      const st = calcStats(tr, OOS_START, OOS_END);
      row.push(st.totalPnl);
      line += `${("$" + fmt(st.totalPnl)).padStart(10)}`;
    }
    gridOos.push(row);
    console.log(line);
  }

  // Check if 4.5/-3.0 is peak or plateau
  const baseIdx = [2, 2]; // 4.5 in row, -3.0 in col
  const baseVal = gridFull[baseIdx[0]][baseIdx[1]];
  let neighborCount = 0, profitableNeighbors = 0;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      if (di === 0 && dj === 0) continue;
      const ri = baseIdx[0] + di, ci = baseIdx[1] + dj;
      if (ri >= 0 && ri < gridFull.length && ci >= 0 && ci < gridFull[0].length) {
        neighborCount++;
        if (gridFull[ri][ci] > 0) profitableNeighbors++;
      }
    }
  }
  const plateauPct = profitableNeighbors / neighborCount * 100;
  const paramV = plateauPct >= 75 ? "PASS" : (plateauPct >= 50 ? "WARNING" : "FAIL");
  console.log(`  Neighbors profitable: ${profitableNeighbors}/${neighborCount} (${fmt(plateauPct)}%). Verdict: ${paramV}`);
  console.log();

  // ─── TEST 5: FILTER ABLATION ──────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 5: FILTER ABLATION");
  console.log("  Remove each filter one at a time. How much does each contribute?");
  console.log("=".repeat(80));

  const ablations: { name: string; flags: FilterFlags }[] = [
    { name: "All filters (baseline)", flags: { useAdx: true, useEma: true, useBtc: true, useAtr: true } },
    { name: "No ADX filter", flags: { useAdx: false, useEma: true, useBtc: true, useAtr: true } },
    { name: "No EMA filter", flags: { useAdx: true, useEma: false, useBtc: true, useAtr: true } },
    { name: "No BTC filter", flags: { useAdx: true, useEma: true, useBtc: false, useAtr: true } },
    { name: "No ATR vol filter", flags: { useAdx: true, useEma: true, useBtc: true, useAtr: false } },
    { name: "NO FILTERS (raw z)", flags: { useAdx: false, useEma: false, useBtc: false, useAtr: false } },
  ];

  for (const period of [{ name: "FULL", s: FULL_START, e: OOS_END }, { name: "OOS", s: OOS_START, e: OOS_END }]) {
    console.log(`\n  ${period.name} PERIOD:`);
    let basePnl = 0;
    for (const abl of ablations) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: period.s, endTs: period.e, filters: abl.flags });
      const st = calcStats(tr, period.s, period.e);
      if (abl.name.includes("baseline")) basePnl = st.totalPnl;
      const delta = st.totalPnl - basePnl;
      const v = abl.name.includes("baseline")
        ? ""
        : (st.totalPnl > basePnl ? "WARNING (filter hurts!)" : (st.totalPnl > 0 ? "PASS" : "FAIL (filter critical)"));
      console.log(`  ${abl.name.padEnd(28)} ${fmtS(st)} delta=$${fmt(delta)} ${v}`);
    }
  }
  console.log();

  // ─── TEST 6: REGIME SPLIT (6-MONTH CHUNKS) ────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 6: REGIME SPLIT (6-MONTH CHUNKS)");
  console.log("  How many 6-month periods are profitable?");
  console.log("=".repeat(80));

  const chunks: { name: string; s: number; e: number }[] = [];
  let chunkStart = FULL_START;
  while (chunkStart < OOS_END) {
    const chunkEnd = Math.min(chunkStart + 180 * D, OOS_END);
    const sDate = new Date(chunkStart).toISOString().slice(0, 7);
    const eDate = new Date(chunkEnd).toISOString().slice(0, 7);
    chunks.push({ name: `${sDate} to ${eDate}`, s: chunkStart, e: chunkEnd });
    chunkStart = chunkEnd;
  }

  let profitableChunks = 0;
  for (const chunk of chunks) {
    const tr = simulate(pdm, btcPd, PAIRS, { startTs: chunk.s, endTs: chunk.e });
    const st = calcStats(tr, chunk.s, chunk.e);
    const v = st.totalPnl > 0 ? "PASS" : "FAIL";
    if (st.totalPnl > 0) profitableChunks++;
    console.log(`  ${chunk.name}: ${fmtS(st)} -> ${v}`);
  }
  const regimeV = profitableChunks >= chunks.length * 0.6 ? "PASS" : (profitableChunks >= chunks.length * 0.4 ? "WARNING" : "FAIL");
  console.log(`  Profitable chunks: ${profitableChunks}/${chunks.length}. Verdict: ${regimeV}`);
  console.log();

  // ─── TEST 7: MAX HOLD SENSITIVITY ─────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 7: MAX HOLD SENSITIVITY");
  console.log("  Does longer hold help or hurt?");
  console.log("=".repeat(80));

  const holdTests = [12, 24, 48, 96, 168]; // hours (bars)
  for (const period of [{ name: "FULL", s: FULL_START, e: OOS_END }, { name: "OOS", s: OOS_START, e: OOS_END }]) {
    console.log(`\n  ${period.name} PERIOD:`);
    for (const mhBars of holdTests) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: period.s, endTs: period.e, maxHoldBars: mhBars });
      const st = calcStats(tr, period.s, period.e);
      const label = `${mhBars}h`.padEnd(6);
      const v = st.totalPnl > 0 ? (st.totalPnl > baselineFull * 0.5 || period.name === "OOS" ? "PASS" : "WARNING") : "FAIL";
      console.log(`  ${label}: ${fmtS(st)} -> ${v}`);
    }
  }
  console.log();

  // ─── TEST 8: SL/TP GRID ──────────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  TEST 8: SL/TP SENSITIVITY GRID");
  console.log("  Is 3%/10% optimal or arbitrary?");
  console.log("=".repeat(80));

  const slTests = [0.02, 0.03, 0.04, 0.05];
  const tpTests = [0.05, 0.07, 0.10, 0.15];

  console.log("  FULL PERIOD (PnL):");
  console.log(`  ${"SL\\TP".padEnd(8)}${tpTests.map(t => `${(t * 100).toFixed(0)}%`.padStart(10)).join("")}`);
  let bestSlTpPnl = -Infinity;
  let bestSl = 0, bestTp = 0;
  for (const sl of slTests) {
    let line = `  ${(sl * 100).toFixed(0)}%`.padEnd(8);
    for (const tp of tpTests) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: FULL_START, endTs: OOS_END, slPct: sl, tpPct: tp });
      const st = calcStats(tr, FULL_START, OOS_END);
      line += `${("$" + fmt(st.totalPnl)).padStart(10)}`;
      if (st.totalPnl > bestSlTpPnl) { bestSlTpPnl = st.totalPnl; bestSl = sl; bestTp = tp; }
    }
    console.log(line);
  }
  console.log(`  Best: SL=${(bestSl * 100).toFixed(0)}% TP=${(bestTp * 100).toFixed(0)}% ($${fmt(bestSlTpPnl)})`);

  console.log("\n  OOS PERIOD (PnL):");
  console.log(`  ${"SL\\TP".padEnd(8)}${tpTests.map(t => `${(t * 100).toFixed(0)}%`.padStart(10)).join("")}`);
  let bestOosPnl = -Infinity;
  let bestOosSl = 0, bestOosTp = 0;
  for (const sl of slTests) {
    let line = `  ${(sl * 100).toFixed(0)}%`.padEnd(8);
    for (const tp of tpTests) {
      const tr = simulate(pdm, btcPd, PAIRS, { startTs: OOS_START, endTs: OOS_END, slPct: sl, tpPct: tp });
      const st = calcStats(tr, OOS_START, OOS_END);
      line += `${("$" + fmt(st.totalPnl)).padStart(10)}`;
      if (st.totalPnl > bestOosPnl) { bestOosPnl = st.totalPnl; bestOosSl = sl; bestOosTp = tp; }
    }
    console.log(line);
  }
  console.log(`  Best OOS: SL=${(bestOosSl * 100).toFixed(0)}% TP=${(bestOosTp * 100).toFixed(0)}% ($${fmt(bestOosPnl)})`);

  const slTpV = bestSl === SL_PCT && bestTp === TP_PCT ? "PASS (chosen params are optimal)"
    : (Math.abs(bestSlTpPnl - baselineFull) / Math.max(Math.abs(baselineFull), 0.01) < 0.3 ? "PASS (near optimal)" : "WARNING (not optimal)");
  console.log(`  Verdict: ${slTpV}`);
  console.log();

  // ─── SUMMARY ──────────────────────────────────────────────────────

  console.log("=".repeat(80));
  console.log("  FINAL SUMMARY");
  console.log("=".repeat(80));
  console.log();
  console.log(`  1. Direction Bias ........... ${biasV}`);
  console.log(`  2. Spread Sensitivity ....... (see above)`);
  console.log(`  3. Entry Slippage ........... (see above)`);
  console.log(`  4. Z-Threshold Sensitivity .. ${paramV}`);
  console.log(`  5. Filter Ablation .......... (see above)`);
  console.log(`  6. Regime Split ............. ${regimeV}`);
  console.log(`  7. Max Hold Sensitivity ..... (see above)`);
  console.log(`  8. SL/TP Sensitivity ........ ${slTpV}`);
  console.log();
  console.log(`  Baseline FULL: $${fmt(baselineFull)} (${fullStats.n} trades, $/d=$${fmt(fullStats.dailyPnl)})`);
  console.log(`  Baseline OOS:  $${fmt(baselineOos)} (${oosStats.n} trades, $/d=$${fmt(oosStats.dailyPnl)})`);
  console.log();

  // Count failures
  const tests = [biasV, paramV, regimeV];
  const fails = tests.filter(v => v === "FAIL").length;
  const warns = tests.filter(v => v === "WARNING").length;
  if (fails > 0) {
    console.log(`  OVERALL: ${fails} FAIL(s), ${warns} WARNING(s) -- STRATEGY HAS CRITICAL WEAKNESSES`);
  } else if (warns > 0) {
    console.log(`  OVERALL: 0 FAILs, ${warns} WARNING(s) -- STRATEGY NEEDS ATTENTION`);
  } else {
    console.log(`  OVERALL: ALL PASS -- Strategy appears robust (but past != future)`);
  }
  console.log("=".repeat(80));
}

main();
