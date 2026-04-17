/**
 * GARCH v2 Deep Trade Analysis
 *
 * Config: $5 margin, SL 1.5% (cap 2%), no TP, trail 25/6->30/3->35/1, unlimited positions
 * Pairs: current 25 + ADD pairs with PF > 1.3 from bt-garch-new-pairs research
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-analysis.ts 2>&1
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const LEV = 10;

// Analysis config
const MARGIN = 5;
const NOT = MARGIN * LEV;
const SL_PCT = 0.015;
const SL_CAP = 0.02;
const TP_PCT = 0; // no TP

// GARCH v2 params
const MOM_LB = 3;
const VOL_WIN = 20;
const Z_LONG_1H = 4.5;
const Z_LONG_4H = 3.0;
const Z_SHORT_1H = -3.0;
const Z_SHORT_4H = -3.0;
const MAX_HOLD_H = 96;

// Stepped trailing
const TRAIL_STEPS = [
  { activate: 25, dist: 6 },
  { activate: 30, dist: 3 },
  { activate: 35, dist: 1 },
];

// BTC EMA filter
const BTC_EMA_FAST = 9;
const BTC_EMA_SLOW = 21;

// Spread map
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;

// OOS window
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

const DISPLAY_MAP: Record<string, string> = {
  "1000PEPE": "kPEPE",
  "1000FLOKI": "kFLOKI",
  "1000BONK": "kBONK",
  "1000SHIB": "kSHIB",
};

// Current 25 production pairs
const CURRENT_25 = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH",
  "TIA", "SOL", "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
];

// ADD pairs from bt-garch-new-pairs (PF > 1.3 candidates based on previous run)
// These are pairs with good scores from the new pairs research
const ADD_CANDIDATES = [
  "ALGO", "ATOM", "FIL", "HBAR", "ICP", "PENDLE", "PNUT", "POL",
  "POPCAT", "RENDER", "RUNE", "SNX", "STX", "TAO",
  "JUP", "SEI", "TON", "AAVE", "ONDO", "INJ", "SAND", "MANA", "CRV",
  "BNB", "LTC", "BCH", "DYDX", "MKR", "GRT", "IMX", "BLUR", "JTO",
  "TRX", "XLM", "PYTH",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }

interface TradeMeta {
  pair: string;
  dir: "long" | "short";
  ep: number;
  xp: number;
  et: number;
  xt: number;
  pnl: number;
  reason: string;
  z1h: number;
  z4h: number;
  hour: number;
  btcRegime: "bull" | "bear" | "neutral";
}

interface PairIndicators {
  h1: C[];
  h4: C[];
  z1h: number[];
  z4h: number[];
  h1Ema9: number[];
  h1Ema21: number[];
  h1TsMap: Map<number, number>;
  h4TsMap: Map<number, number>;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(sym: string): C[] {
  const fp = path.join(CACHE_5M, `${sym}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4] }
      : { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }
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
  for (const [ts, grp] of groups) {
    if (grp.length < minBars) continue;
    grp.sort((a, b) => a.t - b.t);
    result.push({
      t: ts,
      o: grp[0]!.o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1]!.c,
    });
  }
  return result.sort((a, b) => a.t - b.t);
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcEMA(values: number[], period: number): number[] {
  const ema = new Array(values.length).fill(0);
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period && i < values.length; i++) sum += values[i]!;
  if (values.length >= period) {
    ema[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
      ema[i] = values[i]! * k + ema[i - 1]! * (1 - k);
    }
  }
  return ema;
}

function computeZScores(cs: C[], momLb: number, volWin: number): number[] {
  const z = new Array(cs.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < cs.length; i++) {
    const mom = cs[i]!.c / cs[i - momLb]!.c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin); j <= i; j++) {
      const r = cs[j]!.c / cs[j - 1]!.c - 1;
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

function buildPairIndicators(bars5m: C[]): PairIndicators {
  const h1 = aggregate(bars5m, H, 10);
  const h4 = aggregate(bars5m, H4, 40);
  const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
  const z4h = computeZScores(h4, MOM_LB, VOL_WIN);
  const h1Ema9 = calcEMA(h1.map(c => c.c), 9);
  const h1Ema21 = calcEMA(h1.map(c => c.c), 21);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  return { h1, h4, z1h, z4h, h1Ema9, h1Ema21, h1TsMap, h4TsMap };
}

// ─── BTC Filter ─────────────────────────────────────────────────────
interface BtcFilter {
  bullish: (t: number) => boolean;
  bearish: (t: number) => boolean;
  regime: (t: number) => "bull" | "bear" | "neutral";
}

function buildBtcFilter(btcH1: C[]): BtcFilter {
  const closes = btcH1.map(c => c.c);
  const ema9 = calcEMA(closes, BTC_EMA_FAST);
  const ema21 = calcEMA(closes, BTC_EMA_SLOW);
  const tsMap = new Map<number, number>();
  btcH1.forEach((c, i) => tsMap.set(c.t, i));

  function getIdx(t: number): number | undefined {
    const bucket = Math.floor(t / H) * H;
    return tsMap.get(bucket);
  }

  return {
    bullish: (t: number) => {
      const i = getIdx(t);
      if (i === undefined || i < BTC_EMA_SLOW) return false;
      return ema9[i - 1]! > ema21[i - 1]!;
    },
    bearish: (t: number) => {
      const i = getIdx(t);
      if (i === undefined || i < BTC_EMA_SLOW) return false;
      return ema9[i - 1]! < ema21[i - 1]!;
    },
    regime: (t: number) => {
      const i = getIdx(t);
      if (i === undefined || i < BTC_EMA_SLOW) return "neutral";
      if (ema9[i - 1]! > ema21[i - 1]!) return "bull";
      if (ema9[i - 1]! < ema21[i - 1]!) return "bear";
      return "neutral";
    },
  };
}

function getLatest4hZ(ind: PairIndicators, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  let idx = ind.h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return ind.z4h[idx - 1]!;
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ind.h4[mid]!.t < t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? ind.z4h[best]! : 0;
}

function calcPnl(dir: "long" | "short", ep: number, xp: number, sp: number, isSL: boolean, notional: number): number {
  const slip = isSL ? sp * 1.5 : sp;
  const exitPx = dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
  const raw = dir === "long" ? (exitPx / ep - 1) * notional : (ep / exitPx - 1) * notional;
  return raw - notional * FEE * 2;
}

// ─── Display helpers ─────────────────────────────────────────────────
function displayName(sym: string): string { return DISPLAY_MAP[sym] ?? sym; }

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "") + "$" + v.toFixed(2);
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function fmtDateShort(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function pad(s: string | number, w: number): string {
  return String(s).padStart(w);
}

function padL(s: string | number, w: number): string {
  return String(s).padEnd(w);
}

// ─── MaxDD from sorted trades ────────────────────────────────────────
function calcMaxDD(trades: TradeMeta[]): number {
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  let cum = 0, peak = 0, maxDD = 0;
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }
  return maxDD;
}

// ─── Portfolio Simulation ────────────────────────────────────────────
function runPortfolio(
  pairNames: string[],
  btcFilter: BtcFilter,
): TradeMeta[] {
  const notional = NOT;
  const SL_COOLDOWN_H = 2;

  interface PairData { name: string; ind: PairIndicators; sp: number; }
  const pairs: PairData[] = [];

  for (const name of pairNames) {
    const sym = Object.entries(DISPLAY_MAP).find(([, v]) => v === name)?.[0] ?? name;
    const raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    pairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }

  console.log(`  Loaded ${pairs.length}/${pairNames.length} pairs`);

  // Collect all OOS hours across all pairs
  const allH1Times: number[] = [];
  for (const p of pairs) {
    for (const bar of p.ind.h1) {
      if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t);
    }
  }
  const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

  interface OpenPos {
    pair: string; dir: "long" | "short"; ep: number; et: number;
    sl: number; tp: number; peakPnlPct: number; sp: number;
    z1h: number; z4h: number; btcRegime: "bull" | "bear" | "neutral";
  }

  const openPositions: OpenPos[] = [];
  const closedTrades: TradeMeta[] = [];
  const cooldowns = new Map<string, number>();

  // Track BTC filter blocks
  let longBlockedByBtc = 0;
  let shortBlockedByBtc = 0;

  for (const hour of uniqueHours) {
    // ─── EXIT ───
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pairData = pairs.find(p => p.name === pos.pair);
      if (!pairData) continue;
      const barIdx = pairData.ind.h1TsMap.get(hour);
      if (barIdx === undefined) continue;
      const bar = pairData.ind.h1[barIdx]!;

      let xp = 0, reason = "", isSL = false;

      const hoursHeld = (hour - pos.et) / H;
      if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      if (!xp && pos.tp > 0) {
        const tpHit = pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp;
        if (tpHit) { xp = pos.tp; reason = "tp"; }
      }

      if (!xp) {
        const best = pos.dir === "long"
          ? (bar.h / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;

        const curr = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.c - 1) * LEV * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) {
          if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
        }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const pnl = calcPnl(pos.dir, pos.ep, xp, pos.sp, isSL, notional);
        closedTrades.push({
          pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
          et: pos.et, xt: hour, pnl, reason,
          z1h: pos.z1h, z4h: pos.z4h,
          hour: new Date(pos.et).getUTCHours(),
          btcRegime: pos.btcRegime,
        });
        openPositions.splice(i, 1);
        if (reason === "sl") {
          cooldowns.set(`${pos.pair}:${pos.dir}`, hour + SL_COOLDOWN_H * H);
        }
      }
    }

    // ─── ENTRY ───
    interface Signal {
      pair: string; dir: "long" | "short"; z1h: number; z4h: number;
      ep: number; sl: number; tp: number; sp: number;
      btcRegime: "bull" | "bear" | "neutral";
    }
    const signals: Signal[] = [];

    for (const p of pairs) {
      const barIdx = p.ind.h1TsMap.get(hour);
      if (barIdx === undefined || barIdx < VOL_WIN + 2) continue;
      const bar = p.ind.h1[barIdx]!;
      const prev = barIdx - 1;

      if (openPositions.some(op => op.pair === p.name)) continue;

      const z1h = p.ind.z1h[prev]!;
      const z4h = getLatest4hZ(p.ind, hour);
      const pairEma9 = p.ind.h1Ema9[prev]!;
      const pairEma21 = p.ind.h1Ema21[prev]!;
      const regime = btcFilter.regime(hour);

      let dir: "long" | "short" | null = null;

      // Long check
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && pairEma9 > pairEma21) {
        if (btcFilter.bullish(hour)) {
          dir = "long";
        } else {
          longBlockedByBtc++;
        }
      }
      // Short check
      if (!dir && z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && pairEma9 < pairEma21) {
        if (btcFilter.bearish(hour)) {
          dir = "short";
        } else {
          shortBlockedByBtc++;
        }
      }

      if (!dir) continue;

      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && hour < cdUntil) continue;

      const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      const tp = TP_PCT > 0 ? (dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT)) : 0;

      signals.push({ pair: p.name, dir, z1h, z4h, ep, sl, tp, sp: p.sp, btcRegime: regime });
    }

    signals.sort((a, b) => Math.abs(b.z1h) - Math.abs(a.z1h));

    for (const sig of signals) {
      openPositions.push({
        pair: sig.pair, dir: sig.dir, ep: sig.ep, et: hour,
        sl: sig.sl, tp: sig.tp, peakPnlPct: 0, sp: sig.sp,
        z1h: sig.z1h, z4h: sig.z4h, btcRegime: sig.btcRegime,
      });
    }
  }

  // Close remaining at end
  for (const pos of openPositions) {
    const pairData = pairs.find(p => p.name === pos.pair);
    if (!pairData) continue;
    const lastBar = pairData.ind.h1[pairData.ind.h1.length - 1]!;
    const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, pos.sp, false, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c,
      et: pos.et, xt: lastBar.t, pnl, reason: "end",
      z1h: pos.z1h, z4h: pos.z4h,
      hour: new Date(pos.et).getUTCHours(),
      btcRegime: pos.btcRegime,
    });
  }

  console.log(`  Long signals blocked by BTC filter: ${longBlockedByBtc}`);
  console.log(`  Short signals blocked by BTC filter: ${shortBlockedByBtc}`);

  return closedTrades.sort((a, b) => a.xt - b.xt);
}

// ─── Analysis Functions ──────────────────────────────────────────────

function sectionHeader(title: string) {
  console.log("\n" + "=".repeat(80));
  console.log("  " + title);
  console.log("=".repeat(80));
}

// A) Monthly PnL Heatmap
function analysisMonthly(trades: TradeMeta[]) {
  sectionHeader("A) MONTHLY PnL HEATMAP");

  interface MonthData { pnl: number; n: number; wins: number; gp: number; gl: number; }
  const monthly = new Map<string, MonthData>();

  for (const t of trades) {
    const d = new Date(t.xt);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const m = monthly.get(key) ?? { pnl: 0, n: 0, wins: 0, gp: 0, gl: 0 };
    m.pnl += t.pnl;
    m.n++;
    if (t.pnl > 0) { m.wins++; m.gp += t.pnl; } else { m.gl += Math.abs(t.pnl); }
    monthly.set(key, m);
  }

  const months = [...monthly.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  console.log("\n  " + padL("Month", 8) + pad("Trades", 8) + pad("WR%", 7) + pad("PF", 7) + pad("PnL", 10));
  console.log("  " + "-".repeat(42));

  let worstMonths: [string, MonthData][] = [];
  for (const [month, m] of months) {
    const wr = m.n > 0 ? (m.wins / m.n * 100) : 0;
    const pf = m.gl > 0 ? m.gp / m.gl : (m.gp > 0 ? Infinity : 0);
    const pfStr = pf === Infinity ? "  Inf" : pf.toFixed(2);
    const marker = m.pnl < 0 ? " <-- LOSS" : "";
    console.log("  " + padL(month, 8) + pad(m.n, 8) + pad(wr.toFixed(1) + "%", 7) + pad(pfStr, 7) + pad(fmtPnl(m.pnl), 10) + marker);
    if (m.pnl < 0) worstMonths.push([month, m]);
  }

  worstMonths.sort((a, b) => a[1].pnl - b[1].pnl);
  const worst3 = worstMonths.slice(0, 3);
  if (worst3.length > 0) {
    console.log(`\n  Worst months: ${worst3.map(([m, d]) => `${m} (${fmtPnl(d.pnl)})`).join(", ")}`);
  }
  return worst3.map(([m]) => m);
}

// B) Weekly PnL for worst 3 months
function analysisWeekly(trades: TradeMeta[], worstMonths: string[]) {
  sectionHeader("B) WEEKLY PnL (Worst 3 Months)");

  for (const month of worstMonths) {
    const [year, mon] = month.split("-").map(Number) as [number, number];
    const monthTrades = trades.filter(t => {
      const d = new Date(t.xt);
      return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === mon;
    });

    interface WeekData { pnl: number; n: number; wins: number; }
    const weekly = new Map<string, WeekData>();

    for (const t of monthTrades) {
      const d = new Date(t.xt);
      const dayOfWeek = d.getUTCDay(); // 0=Sun
      const dayOfMonth = d.getUTCDate();
      // week number within month (approx)
      const weekStart = new Date(d.getTime());
      weekStart.setUTCDate(dayOfMonth - dayOfWeek);
      const key = `W${weekStart.toISOString().slice(0, 10)}`;
      const w = weekly.get(key) ?? { pnl: 0, n: 0, wins: 0 };
      w.pnl += t.pnl;
      w.n++;
      if (t.pnl > 0) w.wins++;
      weekly.set(key, w);
    }

    const weeks = [...weekly.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    console.log(`\n  Month: ${month} (${monthTrades.length} trades)`);
    console.log("  " + padL("Week", 14) + pad("Trades", 8) + pad("WR%", 7) + pad("PnL", 10));
    console.log("  " + "-".repeat(40));

    let worstWeek = { key: "", pnl: 0 };
    for (const [week, w] of weeks) {
      const wr = w.n > 0 ? (w.wins / w.n * 100) : 0;
      const marker = w.pnl < worstWeek.pnl ? " <-- WORST" : "";
      if (w.pnl < worstWeek.pnl) { worstWeek.key = week; worstWeek.pnl = w.pnl; }
      console.log("  " + padL(week, 14) + pad(w.n, 8) + pad(wr.toFixed(1) + "%", 7) + pad(fmtPnl(w.pnl), 10));
    }
    if (worstWeek.key) {
      console.log(`  Worst week: ${worstWeek.key} (${fmtPnl(worstWeek.pnl)})`);
    }
  }
}

// C) Worst 20 Trades
function analysisWorstTrades(trades: TradeMeta[]) {
  sectionHeader("C) WORST 20 TRADES");

  const sorted = [...trades].sort((a, b) => a.pnl - b.pnl).slice(0, 20);

  console.log("\n  " +
    padL("Pair", 8) + padL("Dir", 6) + padL("Entry Date", 17) + padL("Exit Date", 17) +
    pad("EntryPx", 10) + pad("ExitPx", 10) + pad("PnL", 9) + padL("Reason", 8) +
    pad("z1h", 7) + pad("z4h", 7)
  );
  console.log("  " + "-".repeat(103));

  for (const t of sorted) {
    console.log("  " +
      padL(t.pair, 8) + padL(t.dir, 6) +
      padL(fmtDate(t.et), 17) + padL(fmtDate(t.xt), 17) +
      pad(t.ep.toFixed(4), 10) + pad(t.xp.toFixed(4), 10) +
      pad(fmtPnl(t.pnl), 9) + padL(t.reason, 8) +
      pad(t.z1h.toFixed(2), 7) + pad(t.z4h.toFixed(2), 7)
    );
  }
}

// D) Per-Pair PnL
function analysisPairPnl(trades: TradeMeta[]) {
  sectionHeader("D) PER-PAIR PnL");

  interface PairStat { n: number; wins: number; losses: number; pnl: number; gp: number; gl: number; }
  const pairStats = new Map<string, PairStat>();

  for (const t of trades) {
    const s = pairStats.get(t.pair) ?? { n: 0, wins: 0, losses: 0, pnl: 0, gp: 0, gl: 0 };
    s.n++;
    s.pnl += t.pnl;
    if (t.pnl > 0) { s.wins++; s.gp += t.pnl; } else { s.losses++; s.gl += Math.abs(t.pnl); }
    pairStats.set(t.pair, s);
  }

  const sorted = [...pairStats.entries()].sort((a, b) => a[1].pnl - b[1].pnl);

  console.log("\n  " + padL("Pair", 10) + pad("Trades", 8) + pad("Wins", 6) + pad("Losses", 8) +
    pad("PnL", 10) + pad("PF", 7) + pad("WR%", 7));
  console.log("  " + "-".repeat(58));

  const losingPairs: string[] = [];
  for (const [pair, s] of sorted) {
    const wr = s.n > 0 ? (s.wins / s.n * 100) : 0;
    const pf = s.gl > 0 ? s.gp / s.gl : (s.gp > 0 ? Infinity : 0);
    const pfStr = pf === Infinity ? "  Inf" : pf.toFixed(2);
    const marker = s.pnl < 0 ? " <-- LOSING" : "";
    if (s.pnl < 0) losingPairs.push(pair);
    console.log("  " + padL(pair, 10) + pad(s.n, 8) + pad(s.wins, 6) + pad(s.losses, 8) +
      pad(fmtPnl(s.pnl), 10) + pad(pfStr, 7) + pad(wr.toFixed(1) + "%", 7) + marker);
  }

  if (losingPairs.length > 0) {
    console.log(`\n  Losing pairs (${losingPairs.length}): ${losingPairs.join(", ")}`);
  } else {
    console.log("\n  All pairs profitable.");
  }
}

// E) Long vs Short
function analysisLongShort(trades: TradeMeta[]) {
  sectionHeader("E) LONG vs SHORT SPLIT");

  for (const dir of ["long", "short"] as const) {
    const subset = trades.filter(t => t.dir === dir);
    if (subset.length === 0) {
      console.log(`\n  ${dir.toUpperCase()}: no trades`);
      continue;
    }
    const wins = subset.filter(t => t.pnl > 0);
    const losses = subset.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const totalPnl = subset.reduce((s, t) => s + t.pnl, 0);
    const wr = wins.length / subset.length * 100;
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const avgPnl = totalPnl / subset.length;
    const maxDD = calcMaxDD(subset);

    console.log(`\n  ${dir.toUpperCase()}:`);
    console.log(`    Count:     ${subset.length}`);
    console.log(`    WR:        ${wr.toFixed(1)}%`);
    console.log(`    PF:        ${pf === Infinity ? "Inf" : pf.toFixed(2)}`);
    console.log(`    Total PnL: ${fmtPnl(totalPnl)}`);
    console.log(`    Avg PnL:   ${fmtPnl(avgPnl)}`);
    console.log(`    MaxDD:     $${maxDD.toFixed(2)}`);
  }
}

// F) Hourly Performance
function analysisHourly(trades: TradeMeta[]) {
  sectionHeader("F) HOURLY PERFORMANCE (entry hour UTC)");

  interface HourStat { n: number; wins: number; pnl: number; }
  const hourStats = new Map<number, HourStat>();

  for (const t of trades) {
    const h = t.hour;
    const s = hourStats.get(h) ?? { n: 0, wins: 0, pnl: 0 };
    s.n++;
    s.pnl += t.pnl;
    if (t.pnl > 0) s.wins++;
    hourStats.set(h, s);
  }

  console.log("\n  " + padL("Hour", 6) + pad("Trades", 8) + pad("WR%", 7) + pad("PnL", 10) + pad("Avg/Tr", 9));
  console.log("  " + "-".repeat(42));

  let bestHour = { h: -1, pnl: -Infinity };
  let worstHour = { h: -1, pnl: Infinity };

  for (let h = 0; h < 24; h++) {
    const s = hourStats.get(h);
    if (!s || s.n === 0) {
      console.log("  " + padL(`${String(h).padStart(2)}:00`, 6) + pad(0, 8) + pad("-", 7) + pad("-", 10) + pad("-", 9));
      continue;
    }
    const wr = (s.wins / s.n * 100).toFixed(1) + "%";
    const avg = s.pnl / s.n;
    if (s.pnl > bestHour.pnl) { bestHour.h = h; bestHour.pnl = s.pnl; }
    if (s.pnl < worstHour.pnl) { worstHour.h = h; worstHour.pnl = s.pnl; }
    console.log("  " + padL(`${String(h).padStart(2)}:00`, 6) + pad(s.n, 8) + pad(wr, 7) +
      pad(fmtPnl(s.pnl), 10) + pad(fmtPnl(avg), 9));
  }

  if (bestHour.h >= 0) {
    console.log(`\n  Best hour:  ${bestHour.h}:00 UTC (${fmtPnl(bestHour.pnl)})`);
  }
  if (worstHour.h >= 0 && worstHour.h !== bestHour.h) {
    console.log(`  Worst hour: ${worstHour.h}:00 UTC (${fmtPnl(worstHour.pnl)})`);
  }
}

// G) Losing Streak Analysis
function analysisLosingStreaks(trades: TradeMeta[]) {
  sectionHeader("G) LOSING STREAK ANALYSIS (>= 5 trades)");

  interface Streak { start: number; end: number; length: number; loss: number; pairs: string[]; }
  const streaks: Streak[] = [];

  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  let i = 0;
  while (i < sorted.length) {
    if (sorted[i]!.pnl < 0) {
      let j = i;
      let loss = 0;
      const pairs: string[] = [];
      while (j < sorted.length && sorted[j]!.pnl < 0) {
        loss += sorted[j]!.pnl;
        pairs.push(sorted[j]!.pair);
        j++;
      }
      if (j - i >= 5) {
        streaks.push({
          start: sorted[i]!.xt,
          end: sorted[j - 1]!.xt,
          length: j - i,
          loss,
          pairs: [...new Set(pairs)],
        });
      }
      i = j;
    } else {
      i++;
    }
  }

  if (streaks.length === 0) {
    console.log("\n  No losing streaks >= 5 trades found.");
    return;
  }

  streaks.sort((a, b) => a.loss - b.loss);

  console.log("\n  " + padL("Start", 18) + padL("End", 18) + pad("Len", 5) + pad("Loss", 10) + "  Pairs");
  console.log("  " + "-".repeat(80));
  for (const s of streaks) {
    console.log("  " + padL(fmtDateShort(s.start), 18) + padL(fmtDateShort(s.end), 18) +
      pad(s.length, 5) + pad(fmtPnl(s.loss), 10) + "  " + s.pairs.slice(0, 8).join(", "));
  }
}

// H) Loss Correlation
function analysisLossCorrelation(trades: TradeMeta[]) {
  sectionHeader("H) LOSS CORRELATION (simultaneous losers)");

  // For each trade that closed as a loss, how many other trades were also open and losing that same hour?
  // We look at the xt (exit hour) of each losing trade
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);

  const buckets = [
    { label: "1-2 simultaneous losers", min: 1, max: 2, count: 0, totalLoss: 0 },
    { label: "3-5 simultaneous losers", min: 3, max: 5, count: 0, totalLoss: 0 },
    { label: "6-10 simultaneous losers", min: 6, max: 10, count: 0, totalLoss: 0 },
    { label: "10+ simultaneous losers", min: 11, max: Infinity, count: 0, totalLoss: 0 },
  ];

  let totalLosses = 0;
  let totalSimultaneous = 0;

  for (const t of sorted) {
    if (t.pnl >= 0) continue;
    // Count how many other open positions at t.xt are also losing
    // A trade is "open" at t.xt if et <= t.xt <= xt (approximately)
    const simultaneousLosers = sorted.filter(other =>
      other !== t &&
      other.pnl < 0 &&
      other.et <= t.xt &&
      other.xt >= t.xt
    ).length;

    totalLosses++;
    totalSimultaneous += simultaneousLosers;

    for (const bucket of buckets) {
      if (simultaneousLosers >= bucket.min && simultaneousLosers <= bucket.max) {
        bucket.count++;
        bucket.totalLoss += t.pnl;
      }
    }
  }

  const avgSimultaneous = totalLosses > 0 ? totalSimultaneous / totalLosses : 0;
  console.log(`\n  Total losing trades: ${totalLosses}`);
  console.log(`  Avg simultaneous losers when a loss occurs: ${avgSimultaneous.toFixed(1)}`);
  console.log();

  for (const b of buckets) {
    const pct = totalLosses > 0 ? (b.count / totalLosses * 100).toFixed(1) : "0.0";
    console.log(`  ${padL(b.label, 30)} ${pad(b.count, 5)} trades (${pct}%)  loss: ${fmtPnl(b.totalLoss)}`);
  }
}

// I) BTC Regime Split
function analysisBtcRegime(trades: TradeMeta[], longBlockedByBtcRef: { v: number }, shortBlockedByBtcRef: { v: number }) {
  sectionHeader("I) BTC REGIME SPLIT");

  for (const regime of ["bull", "bear", "neutral"] as const) {
    const subset = trades.filter(t => t.btcRegime === regime);
    if (subset.length === 0) {
      console.log(`\n  ${regime.toUpperCase()}: no trades`);
      continue;
    }
    const wins = subset.filter(t => t.pnl > 0);
    const losses = subset.filter(t => t.pnl <= 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const totalPnl = subset.reduce((s, t) => s + t.pnl, 0);
    const wr = wins.length / subset.length * 100;
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);

    // Split by direction in this regime
    const longs = subset.filter(t => t.dir === "long");
    const shorts = subset.filter(t => t.dir === "short");

    console.log(`\n  BTC REGIME: ${regime.toUpperCase()} (${subset.length} trades: ${longs.length}L / ${shorts.length}S)`);
    console.log(`    WR:        ${wr.toFixed(1)}%`);
    console.log(`    PF:        ${pf === Infinity ? "Inf" : pf.toFixed(2)}`);
    console.log(`    Total PnL: ${fmtPnl(totalPnl)}`);
  }

  // Long signals blocked by BTC filter (from runPortfolio)
  console.log(`\n  Long signals blocked by BTC bull filter: ${longBlockedByBtcRef.v}`);
  console.log(`  Short signals blocked by BTC bear filter: ${shortBlockedByBtcRef.v}`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(80));
  console.log("  GARCH v2 DEEP TRADE ANALYSIS");
  console.log("  Config: $5 margin, SL 1.5% (cap 2%), no TP, trail 25/6->30/3->35/1");
  console.log("  OOS: 2025-06-01 to 2026-03-25");
  console.log("=".repeat(80));

  // Load BTC
  const btc5m = load5m("BTCUSDT");
  const btcH1 = aggregate(btc5m, H, 10);
  const btcFilter = buildBtcFilter(btcH1);
  console.log(`\nBTC: ${btc5m.length} 5m -> ${btcH1.length} 1h bars`);

  // Build pair list: current 25 (available in cache) + ADD candidates
  // We'll run the individual backtest first to find which ADD pairs have PF > 1.3
  const allCandidates = [...CURRENT_25, ...ADD_CANDIDATES];
  const uniqueCandidates = [...new Set(allCandidates)];

  console.log(`\nRunning quick individual PF check for ${uniqueCandidates.length} pairs...`);

  // Quick individual run to find ADD pairs with PF > 1.3
  interface QuickResult { name: string; pf: number; n: number; perDay: number; pnl: number; }
  const quickResults: QuickResult[] = [];

  const oosDays = (OOS_END - OOS_START) / D;

  for (const name of uniqueCandidates) {
    const sym = Object.entries(DISPLAY_MAP).find(([, v]) => v === name)?.[0] ?? name;
    const raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;

    const sp = SP[name] ?? DEFAULT_SPREAD;
    const trades: { pnl: number }[] = [];

    interface Pos {
      dir: "long" | "short"; ep: number; et: number; sl: number; tp: number; peakPnlPct: number;
    }
    let pos: Pos | null = null;

    for (let barIdx = VOL_WIN + 2; barIdx < ind.h1.length; barIdx++) {
      const bar = ind.h1[barIdx]!;
      const prev = barIdx - 1;

      if (pos) {
        const hoursHeld = (bar.t - pos.et) / H;
        if (hoursHeld >= MAX_HOLD_H) {
          const pnl = calcPnl(pos.dir, pos.ep, bar.c, sp, false, NOT);
          if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pnl });
          pos = null;
        }
        if (pos) {
          const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
          if (slHit) {
            const pnl = calcPnl(pos.dir, pos.ep, pos.sl, sp, true, NOT);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pnl });
            pos = null;
          }
        }
        if (pos && pos.tp > 0) {
          const tpHit = pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp;
          if (tpHit) {
            const pnl = calcPnl(pos.dir, pos.ep, pos.tp, sp, false, NOT);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pnl });
            pos = null;
          }
        }
        if (pos) {
          const best = pos.dir === "long"
            ? (bar.h / pos.ep - 1) * LEV * 100
            : (pos.ep / bar.l - 1) * LEV * 100;
          if (best > pos.peakPnlPct) pos.peakPnlPct = best;
          const curr = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * LEV * 100
            : (pos.ep / bar.c - 1) * LEV * 100;
          let trailDist = Infinity;
          for (const step of TRAIL_STEPS) {
            if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
          }
          if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
            const pnl = calcPnl(pos.dir, pos.ep, bar.c, sp, false, NOT);
            if (pos.et >= OOS_START && pos.et < OOS_END) trades.push({ pnl });
            pos = null;
          }
        }
      }

      if (!pos && bar.t >= OOS_START && bar.t < OOS_END) {
        const z1h = ind.z1h[prev]!;
        const z4h = getLatest4hZ(ind, bar.t);
        const pairEma9 = ind.h1Ema9[prev]!;
        const pairEma21 = ind.h1Ema21[prev]!;

        let dir: "long" | "short" | null = null;
        if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && pairEma9 > pairEma21 && btcFilter.bullish(bar.t)) dir = "long";
        if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && pairEma9 < pairEma21 && btcFilter.bearish(bar.t)) dir = "short";

        if (dir) {
          const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
          const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
          const sl = dir === "long" ? ep - slDist : ep + slDist;
          const tp = TP_PCT > 0 ? (dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT)) : 0;
          pos = { dir, ep, et: bar.t, sl, tp, peakPnlPct: 0 };
        }
      }
    }

    if (pos && pos.et >= OOS_START && pos.et < OOS_END) {
      const lastBar = ind.h1[ind.h1.length - 1]!;
      const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, sp, false, NOT);
      trades.push({ pnl });
    }

    if (trades.length < 3) continue;
    const gp = trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    quickResults.push({ name, pf, n: trades.length, perDay: totalPnl / oosDays, pnl: totalPnl });
  }

  // Determine final pair list
  const current25InCache = quickResults
    .filter(r => CURRENT_25.includes(r.name))
    .map(r => r.name);

  const addPairs = quickResults
    .filter(r => !CURRENT_25.includes(r.name) && r.pf > 1.3 && r.perDay > 0 && r.n >= 3)
    .map(r => r.name);

  const finalPairs = [...new Set([...current25InCache, ...addPairs])];

  console.log(`\nCurrent pairs in cache: ${current25InCache.length}`);
  console.log(`ADD pairs (PF > 1.3): ${addPairs.length} -> ${addPairs.join(", ")}`);
  console.log(`Final portfolio: ${finalPairs.length} pairs`);
  console.log(`  ${finalPairs.join(", ")}`);

  // Quick summary table of individual pair results
  sectionHeader("INDIVIDUAL PAIR QUICK SUMMARY");
  const allInCache = quickResults.sort((a, b) => b.pf - a.pf);
  console.log("\n  " + padL("Pair", 10) + pad("N", 6) + pad("PF", 7) + pad("PnL", 10) + pad("$/d", 8) + "  Status");
  console.log("  " + "-".repeat(50));
  for (const r of allInCache) {
    const isCurrent = CURRENT_25.includes(r.name);
    const pfStr = r.pf === Infinity ? "  Inf" : r.pf.toFixed(2);
    const isAdd = !isCurrent && r.pf > 1.3 && r.perDay > 0 && r.n >= 3;
    const status = isCurrent ? "CUR" : isAdd ? "ADD" : r.pf > 1.1 ? "WEAK" : "SKIP";
    console.log("  " + padL(r.name, 10) + pad(r.n, 6) + pad(pfStr, 7) + pad(fmtPnl(r.pnl), 10) +
      pad(fmtPnl(r.perDay), 8) + "  " + status);
  }

  // Run portfolio simulation
  console.log("\n");
  sectionHeader("PORTFOLIO SIMULATION");
  console.log(`\n  Running unified portfolio with ${finalPairs.length} pairs...`);

  // Capture block counts from the simulation
  // We need to patch runPortfolio to expose these
  const longBlockedRef = { v: 0 };
  const shortBlockedRef = { v: 0 };

  // Monkey-patch: instead, run the simulation and capture output
  const trades = await runPortfolioWithBlocks(finalPairs, btcFilter, longBlockedRef, shortBlockedRef);

  // Portfolio summary
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const gp = wins.reduce((s, t) => s + t.pnl, 0);
  const gl = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const wr = trades.length > 0 ? (wins.length / trades.length * 100) : 0;
  const pf = gl > 0 ? gp / gl : Infinity;
  const maxDD = calcMaxDD(trades);
  const slCount = trades.filter(t => t.reason === "sl").length;
  const trailCount = trades.filter(t => t.reason === "trail").length;
  const maxhCount = trades.filter(t => t.reason === "maxh").length;
  const endCount = trades.filter(t => t.reason === "end").length;

  console.log(`\n  Trades:    ${trades.length}`);
  console.log(`  WR:        ${wr.toFixed(1)}%`);
  console.log(`  PF:        ${pf === Infinity ? "Inf" : pf.toFixed(2)}`);
  console.log(`  Total PnL: ${fmtPnl(totalPnl)}`);
  console.log(`  $/day:     ${fmtPnl(totalPnl / oosDays)}`);
  console.log(`  MaxDD:     $${maxDD.toFixed(2)}`);
  console.log(`  Exits:     SL=${slCount} Trail=${trailCount} MaxH=${maxhCount} End=${endCount}`);

  // Deep analysis sections
  const worstMonths = analysisMonthly(trades);
  analysisWeekly(trades, worstMonths);
  analysisWorstTrades(trades);
  analysisPairPnl(trades);
  analysisLongShort(trades);
  analysisHourly(trades);
  analysisLosingStreaks(trades);
  analysisLossCorrelation(trades);
  analysisBtcRegime(trades, longBlockedRef, shortBlockedRef);

  console.log("\n" + "=".repeat(80));
  console.log("  DONE");
  console.log("=".repeat(80));
}

// Portfolio simulation returning trades with block counts
async function runPortfolioWithBlocks(
  pairNames: string[],
  btcFilter: BtcFilter,
  longBlockedRef: { v: number },
  shortBlockedRef: { v: number },
): Promise<TradeMeta[]> {
  const notional = NOT;
  const SL_COOLDOWN_H = 2;

  interface PairData { name: string; ind: PairIndicators; sp: number; }
  const pairs: PairData[] = [];

  for (const name of pairNames) {
    const sym = Object.entries(DISPLAY_MAP).find(([, v]) => v === name)?.[0] ?? name;
    const raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) continue;
    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) continue;
    pairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
  }

  console.log(`  Loaded ${pairs.length}/${pairNames.length} pairs`);

  const allH1Times: number[] = [];
  for (const p of pairs) {
    for (const bar of p.ind.h1) {
      if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t);
    }
  }
  const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

  interface OpenPos {
    pair: string; dir: "long" | "short"; ep: number; et: number;
    sl: number; tp: number; peakPnlPct: number; sp: number;
    z1h: number; z4h: number; btcRegime: "bull" | "bear" | "neutral";
  }

  const openPositions: OpenPos[] = [];
  const closedTrades: TradeMeta[] = [];
  const cooldowns = new Map<string, number>();

  for (const hour of uniqueHours) {
    // EXIT
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i]!;
      const pairData = pairs.find(p => p.name === pos.pair);
      if (!pairData) continue;
      const barIdx = pairData.ind.h1TsMap.get(hour);
      if (barIdx === undefined) continue;
      const bar = pairData.ind.h1[barIdx]!;

      let xp = 0, reason = "", isSL = false;

      const hoursHeld = (hour - pos.et) / H;
      if (hoursHeld >= MAX_HOLD_H) { xp = bar.c; reason = "maxh"; }

      if (!xp) {
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
      }

      if (!xp && pos.tp > 0) {
        const tpHit = pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp;
        if (tpHit) { xp = pos.tp; reason = "tp"; }
      }

      if (!xp) {
        const best = pos.dir === "long"
          ? (bar.h / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;

        const curr = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.c - 1) * LEV * 100;
        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) {
          if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
        }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
          xp = bar.c; reason = "trail";
        }
      }

      if (xp > 0) {
        const pnl = calcPnl(pos.dir, pos.ep, xp, pos.sp, isSL, notional);
        closedTrades.push({
          pair: pos.pair, dir: pos.dir, ep: pos.ep, xp,
          et: pos.et, xt: hour, pnl, reason,
          z1h: pos.z1h, z4h: pos.z4h,
          hour: new Date(pos.et).getUTCHours(),
          btcRegime: pos.btcRegime,
        });
        openPositions.splice(i, 1);
        if (reason === "sl") {
          cooldowns.set(`${pos.pair}:${pos.dir}`, hour + SL_COOLDOWN_H * H);
        }
      }
    }

    // ENTRY
    interface Signal {
      pair: string; dir: "long" | "short"; z1h: number; z4h: number;
      ep: number; sl: number; tp: number; sp: number;
      btcRegime: "bull" | "bear" | "neutral";
    }
    const signals: Signal[] = [];

    for (const p of pairs) {
      const barIdx = p.ind.h1TsMap.get(hour);
      if (barIdx === undefined || barIdx < VOL_WIN + 2) continue;
      const bar = p.ind.h1[barIdx]!;
      const prev = barIdx - 1;

      if (openPositions.some(op => op.pair === p.name)) continue;

      const z1h = p.ind.z1h[prev]!;
      const z4h = getLatest4hZ(p.ind, hour);
      const pairEma9 = p.ind.h1Ema9[prev]!;
      const pairEma21 = p.ind.h1Ema21[prev]!;
      const regime = btcFilter.regime(hour);

      let dir: "long" | "short" | null = null;

      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && pairEma9 > pairEma21) {
        if (btcFilter.bullish(hour)) {
          dir = "long";
        } else {
          longBlockedRef.v++;
        }
      }
      if (!dir && z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && pairEma9 < pairEma21) {
        if (btcFilter.bearish(hour)) {
          dir = "short";
        } else {
          shortBlockedRef.v++;
        }
      }

      if (!dir) continue;

      const cdKey = `${p.name}:${dir}`;
      const cdUntil = cooldowns.get(cdKey);
      if (cdUntil && hour < cdUntil) continue;

      const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
      const slDist = Math.min(ep * SL_PCT, ep * SL_CAP);
      const sl = dir === "long" ? ep - slDist : ep + slDist;
      const tp = TP_PCT > 0 ? (dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT)) : 0;

      signals.push({ pair: p.name, dir, z1h, z4h, ep, sl, tp, sp: p.sp, btcRegime: regime });
    }

    signals.sort((a, b) => Math.abs(b.z1h) - Math.abs(a.z1h));

    for (const sig of signals) {
      openPositions.push({
        pair: sig.pair, dir: sig.dir, ep: sig.ep, et: hour,
        sl: sig.sl, tp: sig.tp, peakPnlPct: 0, sp: sig.sp,
        z1h: sig.z1h, z4h: sig.z4h, btcRegime: sig.btcRegime,
      });
    }
  }

  // Close remaining
  for (const pos of openPositions) {
    const pairData = pairs.find(p => p.name === pos.pair);
    if (!pairData) continue;
    const lastBar = pairData.ind.h1[pairData.ind.h1.length - 1]!;
    const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, pos.sp, false, notional);
    closedTrades.push({
      pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c,
      et: pos.et, xt: lastBar.t, pnl, reason: "end",
      z1h: pos.z1h, z4h: pos.z4h,
      hour: new Date(pos.et).getUTCHours(),
      btcRegime: pos.btcRegime,
    });
  }

  return closedTrades.sort((a, b) => a.xt - b.xt);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
