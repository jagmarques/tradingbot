/**
 * GARCH-chan v2 Final Backtest
 * Exact live engine parameters, 5m->1h aggregation, full analysis.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-final.ts
 */

import * as fs from "fs";
import * as path from "path";
import { ATR, ADX, EMA } from "technicalindicators";

// ---- Types ----

interface Candle { t: number; o: number; h: number; l: number; c: number; }
interface Position {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  entryTime: number;
  stopLoss: number;
  takeProfit: number;
}
interface Trade {
  pair: string;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnl: number;
  reason: string;
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

// ---- Constants ----

const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3600_000;
const D = 86_400_000;
const FEE = 0.00035; // 0.035% taker per side
const SIZE = 10;      // $10 margin
const LEV = 10;       // 10x leverage
const NOTIONAL = SIZE * LEV; // $100

// GARCH v2 exact live params
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
const MAX_HOLD = 48; // bars (1h each)
const MAX_PER_DIR = 6;
const SL_SLIP = 1.5; // SL slippage multiplier

// Spread map
const SP: Record<string, number> = {
  XRPUSDT: 1.05e-4, DOGEUSDT: 1.35e-4, ARBUSDT: 2.6e-4, ENAUSDT: 2.55e-4,
  APTUSDT: 3.2e-4, LINKUSDT: 3.45e-4, TRUMPUSDT: 3.65e-4, WLDUSDT: 4e-4,
  DOTUSDT: 4.95e-4, ADAUSDT: 5.55e-4, LDOUSDT: 5.8e-4, OPUSDT: 6.2e-4,
  BTCUSDT: 0.5e-4, ETHUSDT: 1.5e-4, SOLUSDT: 2.0e-4, TIAUSDT: 2.5e-4,
};

// Target pairs (from live engine)
const PAIRS = [
  "OPUSDT", "ARBUSDT", "LDOUSDT", "TRUMPUSDT", "DOTUSDT", "ENAUSDT",
  "DOGEUSDT", "APTUSDT", "LINKUSDT", "ADAUSDT", "WLDUSDT", "XRPUSDT",
  "SOLUSDT", "TIAUSDT",
];

// ---- Data Loading: 5m -> 1h aggregation ----

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
  // Group 5m bars by hour boundary
  const groups = new Map<number, Candle[]>();
  for (const b of bars5m) {
    const hourTs = Math.floor(b.t / H) * H;
    let arr = groups.get(hourTs);
    if (!arr) { arr = []; groups.set(hourTs, arr); }
    arr.push(b);
  }
  const result: Candle[] = [];
  for (const [ts, grp] of groups) {
    if (grp.length < 10) continue; // need at least 10 of 12 bars
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

// ---- Indicator helpers ----

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

// ---- Precompute ----

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

  // Z-scores: mom = close[i]/close[i-3] - 1, vol = sqrt(sum(r^2)/n) over 20 bars
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

// ---- GARCH Signal (exact v2 logic) ----

function garchSignal(
  pd: PairData,
  barIdx: number,
  btcPd: PairData,
  pairTs: number
): "long" | "short" | null {
  const prev = barIdx - 1; // anti-look-ahead: signal on bar i-1
  if (prev < VOL_WIN + MOM_LB) return null;

  const z = pd.zScores[prev];
  if (isNaN(z) || z === 0) return null;

  const goLong = z > Z_LONG;
  const goShort = z < Z_SHORT;
  if (!goLong && !goShort) return null;

  // ADX filter (asymmetric)
  const adx = getAdx(pd.adx14, prev, pd.candles.length);
  if (!adx) return null;
  if (goLong && adx.adx < ADX_LONG_MIN) return null;
  if (goShort && adx.adx < ADX_SHORT_MIN) return null;

  // EMA 9/21 trend filter
  const e9 = getVal(pd.ema9, prev, pd.candles.length);
  const e21 = getVal(pd.ema21, prev, pd.candles.length);
  if (e9 === null || e21 === null) return null;
  if (goLong && e9 <= e21) return null;
  if (goShort && e9 >= e21) return null;

  // ATR vol filter: current ATR >= 0.9 * ATR 5 bars ago
  const atrNow = getVal(pd.atr14, prev, pd.candles.length);
  const atrOld = getVal(pd.atr14, prev - VOL_LB, pd.candles.length);
  if (atrNow === null || atrOld === null) return null;
  if (atrNow < VOL_RATIO * atrOld) return null;

  // BTC regime filter
  const btcIdx = btcPd.tsMap.get(pairTs);
  if (btcIdx === undefined || btcIdx < 1) return null;
  const btcPrev = btcIdx - 1;
  const be9 = getVal(btcPd.ema9, btcPrev, btcPd.candles.length);
  const be21 = getVal(btcPd.ema21, btcPrev, btcPd.candles.length);
  if (be9 === null || be21 === null) return null;
  const btcTrend = be9 > be21 ? "long" : "short";
  if (goLong && btcTrend !== "long") return null;
  if (goShort && btcTrend !== "short") return null;

  return goLong ? "long" : "short";
}

// ---- Simulation ----

function simulate(
  pdm: Map<string, PairData>,
  btcPd: PairData,
  startTs: number,
  endTs: number,
  pairs: string[]
): Trade[] {
  const pd = new Map<string, PairData>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  // Collect all hourly timestamps in range
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
      const sp = SP[p] ?? 4e-4;

      let exitPrice = 0;
      let reason = "";

      // SL check (intra-bar)
      if (pos.direction === "long" && bar.l <= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 - sp * SL_SLIP);
        reason = "sl";
      } else if (pos.direction === "short" && bar.h >= pos.stopLoss) {
        exitPrice = pos.stopLoss * (1 + sp * SL_SLIP);
        reason = "sl";
      }

      // TP check
      if (!reason) {
        if (pos.direction === "long" && bar.h >= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 - sp);
          reason = "tp";
        } else if (pos.direction === "short" && bar.l <= pos.takeProfit) {
          exitPrice = pos.takeProfit * (1 + sp);
          reason = "tp";
        }
      }

      // Max hold (48 bars = 48h)
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= MAX_HOLD) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = NOTIONAL * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOTIONAL
          : (pos.entryPrice / exitPrice - 1) * NOTIONAL;
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

      const dir = garchSignal(d, bi, btcPd, ts);
      if (!dir) continue;

      // Max per direction cap
      const dirCount = [...open.values()].filter(x => x.direction === dir).length;
      if (dirCount >= MAX_PER_DIR) continue;

      const entryRaw = d.candles[bi].o;
      const sp = SP[p] ?? 4e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);
      const tp = dir === "long" ? entry * (1 + TP_PCT) : entry * (1 - TP_PCT);

      open.set(p, { pair: p, direction: dir, entryPrice: entry, entryTime: ts, stopLoss: sl, takeProfit: tp });
    }
  }

  return trades;
}

// ---- Donchian Baseline ----

function donchianSim(
  pdm: Map<string, PairData>,
  btcPd: PairData,
  startTs: number,
  endTs: number,
  pairs: string[]
): Trade[] {
  const LB = 12; // lookback
  const EX = 10; // exit channel
  const EP = 10; // EMA period for filter

  const pd = new Map<string, PairData>();
  for (const p of pairs) { const d = pdm.get(p); if (d) pd.set(p, d); }

  const allTs = new Set<number>();
  for (const d of pd.values()) {
    for (const c of d.candles) {
      if (c.t >= startTs && c.t < endTs) allTs.add(c.t);
    }
  }
  const sorted = [...allTs].sort((a, b) => a - b);

  const open = new Map<string, Position & { exitChannel: number }>();
  const trades: Trade[] = [];

  for (const ts of sorted) {
    const closedThisBar = new Set<string>();

    // --- EXITS ---
    for (const [p, pos] of open) {
      const d = pd.get(p)!;
      const bi = d.tsMap.get(ts) ?? -1;
      if (bi < 0) continue;
      const bar = d.candles[bi];
      const sp = SP[p] ?? 4e-4;

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

      // Channel exit (using prev bar)
      if (!reason && bi >= EX + 1) {
        const prev = bi - 1;
        if (pos.direction === "long") {
          let chanLow = Infinity;
          for (let k = prev - EX + 1; k <= prev; k++) {
            if (k >= 0 && d.candles[k].l < chanLow) chanLow = d.candles[k].l;
          }
          if (bar.c < chanLow) {
            exitPrice = bar.c * (1 - sp);
            reason = "ch";
          }
        } else {
          let chanHigh = -Infinity;
          for (let k = prev - EX + 1; k <= prev; k++) {
            if (k >= 0 && d.candles[k].h > chanHigh) chanHigh = d.candles[k].h;
          }
          if (bar.c > chanHigh) {
            exitPrice = bar.c * (1 + sp);
            reason = "ch";
          }
        }
      }

      // Stagnation 48h
      if (!reason) {
        const barsHeld = Math.floor((ts - pos.entryTime) / H);
        if (barsHeld >= 48) {
          exitPrice = pos.direction === "long" ? bar.c * (1 - sp) : bar.c * (1 + sp);
          reason = "mh";
        }
      }

      if (reason) {
        const fee = NOTIONAL * FEE * 2;
        const raw = pos.direction === "long"
          ? (exitPrice / pos.entryPrice - 1) * NOTIONAL
          : (pos.entryPrice / exitPrice - 1) * NOTIONAL;
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
      if (bi < LB + 2) continue;

      // Donchian breakout on previous bar (bar n-2 for no look-ahead)
      const prev = bi - 1;
      const prevBar = d.candles[prev];

      // EMA filter (bar n-2)
      const closes = d.candles.slice(0, prev + 1).map(c => c.c);
      if (closes.length < EP) continue;
      const emaArr = EMA.calculate({ period: EP, values: closes });
      if (emaArr.length < 2) continue;
      const emaVal = emaArr[emaArr.length - 1];
      // No EMA filter direction for Donchian, just use channel

      // Donchian channel on bars prev-LB to prev-1 (exclusive of signal bar)
      let chanHigh = -Infinity, chanLow = Infinity;
      for (let k = prev - LB; k < prev; k++) {
        if (k < 0) continue;
        if (d.candles[k].h > chanHigh) chanHigh = d.candles[k].h;
        if (d.candles[k].l < chanLow) chanLow = d.candles[k].l;
      }

      let dir: "long" | "short" | null = null;
      if (prevBar.c > chanHigh) dir = "long";
      else if (prevBar.c < chanLow) dir = "short";
      if (!dir) continue;

      // EMA filter: long only if close > ema, short only if close < ema
      if (dir === "long" && prevBar.c <= emaVal) continue;
      if (dir === "short" && prevBar.c >= emaVal) continue;

      const dirCount = [...open.values()].filter(x => x.direction === dir).length;
      if (dirCount >= 10) continue;

      const entryRaw = d.candles[bi].o;
      const sp = SP[p] ?? 4e-4;
      const entry = dir === "long" ? entryRaw * (1 + sp) : entryRaw * (1 - sp);
      const sl = dir === "long" ? entry * (1 - SL_PCT) : entry * (1 + SL_PCT);

      open.set(p, {
        pair: p, direction: dir, entryPrice: entry, entryTime: ts,
        stopLoss: sl, takeProfit: 0, exitChannel: EX,
      });
    }
  }

  return trades;
}

// ---- Stats ----

interface Stats {
  trades: number;
  wins: number;
  wr: number;
  pnl: number;
  perDay: number;
  maxDd: number;
  sharpe: number;
  pf: number;
  avgWin: number;
  avgLoss: number;
}

function stats(trades: Trade[], days: number): Stats {
  if (trades.length === 0) return { trades: 0, wins: 0, wr: 0, pnl: 0, perDay: 0, maxDd: 0, sharpe: 0, pf: 0, avgWin: 0, avgLoss: 0 };

  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const wr = (wins / trades.length) * 100;

  // Max DD (cumulative)
  let maxDd = 0, peak = 0, cum = 0;
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }

  // Sharpe (daily)
  const dailyMap = new Map<number, number>();
  for (const t of trades) {
    const day = Math.floor(t.exitTime / D);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + t.pnl);
  }
  const dr = Array.from(dailyMap.values());
  const avg = dr.reduce((s, r) => s + r, 0) / Math.max(dr.length, 1);
  const std = Math.sqrt(dr.reduce((s, r) => s + (r - avg) ** 2, 0) / Math.max(dr.length - 1, 1));
  const sharpe = std > 0 ? (avg / std) * Math.sqrt(252) : 0;

  // PF
  const winTrades = trades.filter(t => t.pnl > 0);
  const lossTrades = trades.filter(t => t.pnl <= 0);
  const grossWin = winTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : Infinity;

  const avgWin = winTrades.length > 0 ? grossWin / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? -grossLoss / lossTrades.length : 0;

  return { trades: trades.length, wins, wr, pnl, perDay: pnl / days, maxDd, sharpe, pf, avgWin, avgLoss };
}

function printStats(label: string, s: Stats): void {
  console.log(`${label}`);
  console.log(`  Trades: ${s.trades}  Wins: ${s.wins}  WR: ${s.wr.toFixed(1)}%`);
  console.log(`  PnL: ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}  $/day: ${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`);
  console.log(`  MaxDD: $${s.maxDd.toFixed(2)}  Sharpe: ${s.sharpe.toFixed(2)}  PF: ${s.pf === Infinity ? "inf" : s.pf.toFixed(2)}`);
  console.log(`  AvgWin: $${s.avgWin.toFixed(2)}  AvgLoss: $${s.avgLoss.toFixed(2)}`);
}

// ---- Main ----

console.log("Loading and aggregating 5m -> 1h candles...\n");

const pdm = new Map<string, PairData>();
const allPairsToLoad = [...new Set([...PAIRS, "BTCUSDT"])];
for (const p of allPairsToLoad) {
  const d = precompute(p);
  if (d) {
    pdm.set(p, d);
    // silent
  } else {
    console.log(`  [SKIP] ${p} - insufficient data`);
  }
}
const btcPd = pdm.get("BTCUSDT");
if (!btcPd) { console.error("BTC data missing, cannot run."); process.exit(1); }

const availPairs = PAIRS.filter(p => pdm.has(p));
console.log(`Loaded ${pdm.size} pairs (${availPairs.length} tradeable + BTC)\n`);

// Date ranges
const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();
const OOS_START = new Date("2025-09-01").getTime();
const L30_START = new Date("2026-02-24").getTime();

const fullDays = (FULL_END - FULL_START) / D;
const oosDays = (FULL_END - OOS_START) / D;
const l30Days = (FULL_END - L30_START) / D;

// ========================================
// 1. FULL PERIOD
// ========================================
console.log("=".repeat(60));
console.log("1. FULL PERIOD (2023-01 to 2026-03)");
console.log("=".repeat(60));
const fullTrades = simulate(pdm, btcPd, FULL_START, FULL_END, availPairs);
printStats("GARCH v2 Full Period", stats(fullTrades, fullDays));

// Exit reason breakdown
const reasons = new Map<string, number>();
for (const t of fullTrades) reasons.set(t.reason, (reasons.get(t.reason) ?? 0) + 1);
console.log(`  Exit reasons: ${[...reasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log();

// ========================================
// 2. OOS (2025-09-01 onwards)
// ========================================
console.log("=".repeat(60));
console.log("2. OUT-OF-SAMPLE (2025-09-01 to 2026-03-26)");
console.log("=".repeat(60));
const oosTrades = simulate(pdm, btcPd, OOS_START, FULL_END, availPairs);
printStats("GARCH v2 OOS", stats(oosTrades, oosDays));
const oosReasons = new Map<string, number>();
for (const t of oosTrades) oosReasons.set(t.reason, (oosReasons.get(t.reason) ?? 0) + 1);
console.log(`  Exit reasons: ${[...oosReasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log();

// ========================================
// 3. LAST 30 DAYS
// ========================================
console.log("=".repeat(60));
console.log("3. LAST 30 DAYS (2026-02-24 to 2026-03-26)");
console.log("=".repeat(60));
const l30Trades = simulate(pdm, btcPd, L30_START, FULL_END, availPairs);
printStats("GARCH v2 Last 30d", stats(l30Trades, l30Days));
const l30Reasons = new Map<string, number>();
for (const t of l30Trades) l30Reasons.set(t.reason, (l30Reasons.get(t.reason) ?? 0) + 1);
console.log(`  Exit reasons: ${[...l30Reasons.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);
console.log();

// ========================================
// 4. PER-PAIR BREAKDOWN (full period)
// ========================================
console.log("=".repeat(60));
console.log("4. PER-PAIR BREAKDOWN (Full Period)");
console.log("=".repeat(60));

const pairGroups = new Map<string, Trade[]>();
for (const t of fullTrades) {
  let arr = pairGroups.get(t.pair);
  if (!arr) { arr = []; pairGroups.set(t.pair, arr); }
  arr.push(t);
}

// Sort by PnL descending
const pairEntries = [...pairGroups.entries()].sort((a, b) => {
  const pnlA = a[1].reduce((s, t) => s + t.pnl, 0);
  const pnlB = b[1].reduce((s, t) => s + t.pnl, 0);
  return pnlB - pnlA;
});

console.log(`${"Pair".padEnd(12)} ${"Trades".padStart(6)} ${"WR%".padStart(6)} ${"PnL".padStart(10)} ${"$/day".padStart(8)} ${"MaxDD".padStart(8)} ${"PF".padStart(6)}`);
console.log("-".repeat(60));
for (const [pair, trades] of pairEntries) {
  const s = stats(trades, fullDays);
  const pnlStr = `${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`;
  const pdStr = `${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`;
  console.log(`${pair.padEnd(12)} ${String(s.trades).padStart(6)} ${s.wr.toFixed(1).padStart(6)} ${pnlStr.padStart(10)} ${pdStr.padStart(8)} ${("$" + s.maxDd.toFixed(2)).padStart(8)} ${(s.pf === Infinity ? "inf" : s.pf.toFixed(2)).padStart(6)}`);
}
console.log();

// ========================================
// 5. MONTHLY P&L (last 6 months)
// ========================================
console.log("=".repeat(60));
console.log("5. MONTHLY P&L (Last 6 Months)");
console.log("=".repeat(60));

const months = [
  { label: "2025-10", s: "2025-10-01", e: "2025-11-01" },
  { label: "2025-11", s: "2025-11-01", e: "2025-12-01" },
  { label: "2025-12", s: "2025-12-01", e: "2026-01-01" },
  { label: "2026-01", s: "2026-01-01", e: "2026-02-01" },
  { label: "2026-02", s: "2026-02-01", e: "2026-03-01" },
  { label: "2026-03", s: "2026-03-01", e: "2026-03-26" },
];

console.log(`${"Month".padEnd(10)} ${"Trades".padStart(6)} ${"WR%".padStart(6)} ${"PnL".padStart(10)} ${"$/day".padStart(8)}`);
console.log("-".repeat(42));
for (const m of months) {
  const ms = new Date(m.s).getTime();
  const me = new Date(m.e).getTime();
  const mt = simulate(pdm, btcPd, ms, me, availPairs);
  const mDays = (me - ms) / D;
  const mPnl = mt.reduce((s, t) => s + t.pnl, 0);
  const mWins = mt.filter(t => t.pnl > 0).length;
  const mWr = mt.length > 0 ? (mWins / mt.length * 100) : 0;
  const pnlStr = `${mPnl >= 0 ? "+" : ""}$${mPnl.toFixed(2)}`;
  const pdStr = `${(mPnl / mDays) >= 0 ? "+" : ""}$${(mPnl / mDays).toFixed(2)}`;
  console.log(`${m.label.padEnd(10)} ${String(mt.length).padStart(6)} ${mWr.toFixed(1).padStart(6)} ${pnlStr.padStart(10)} ${pdStr.padStart(8)}`);
}
console.log();

// ========================================
// 6. LONG vs SHORT SPLIT
// ========================================
console.log("=".repeat(60));
console.log("6. LONG vs SHORT SPLIT");
console.log("=".repeat(60));

const fullLong = fullTrades.filter(t => t.direction === "long");
const fullShort = fullTrades.filter(t => t.direction === "short");
printStats("Full Period - LONG", stats(fullLong, fullDays));
console.log();
printStats("Full Period - SHORT", stats(fullShort, fullDays));
console.log();

const oosLong = oosTrades.filter(t => t.direction === "long");
const oosShort = oosTrades.filter(t => t.direction === "short");
printStats("OOS - LONG", stats(oosLong, oosDays));
console.log();
printStats("OOS - SHORT", stats(oosShort, oosDays));
console.log();

// ========================================
// 7. DONCHIAN 30d BASELINE
// ========================================
console.log("=".repeat(60));
console.log("7. DONCHIAN BASELINE COMPARISON (same pairs/periods)");
console.log("=".repeat(60));

const donchFull = donchianSim(pdm, btcPd, FULL_START, FULL_END, availPairs);
const donchOos = donchianSim(pdm, btcPd, OOS_START, FULL_END, availPairs);
const donchL30 = donchianSim(pdm, btcPd, L30_START, FULL_END, availPairs);

printStats("Donchian Full Period", stats(donchFull, fullDays));
console.log();
printStats("Donchian OOS", stats(donchOos, oosDays));
console.log();
printStats("Donchian Last 30d", stats(donchL30, l30Days));
console.log();

// ========================================
// SUMMARY TABLE
// ========================================
console.log("=".repeat(60));
console.log("SUMMARY COMPARISON");
console.log("=".repeat(60));

function summaryLine(label: string, s: Stats): void {
  const pnlStr = `${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(0)}`;
  const pdStr = `${s.perDay >= 0 ? "+" : ""}$${s.perDay.toFixed(2)}`;
  console.log(`${label.padEnd(26)} ${String(s.trades).padStart(5)} ${s.wr.toFixed(1).padStart(6)}% ${pnlStr.padStart(8)} ${pdStr.padStart(8)}/d  Sh=${s.sharpe.toFixed(2).padStart(5)}  PF=${(s.pf === Infinity ? "inf" : s.pf.toFixed(2)).padStart(5)}  DD=$${s.maxDd.toFixed(0)}`);
}

console.log(`${"Strategy".padEnd(26)} ${"Trades".padStart(5)} ${"WR".padStart(7)} ${"PnL".padStart(8)} ${"$/day".padStart(9)}  ${"Sharpe".padStart(8)}  ${"PF".padStart(7)}  MaxDD`);
console.log("-".repeat(90));
summaryLine("GARCH Full", stats(fullTrades, fullDays));
summaryLine("GARCH OOS", stats(oosTrades, oosDays));
summaryLine("GARCH Last 30d", stats(l30Trades, l30Days));
summaryLine("Donchian Full", stats(donchFull, fullDays));
summaryLine("Donchian OOS", stats(donchOos, oosDays));
summaryLine("Donchian Last 30d", stats(donchL30, l30Days));
console.log();

console.log("Done.");
