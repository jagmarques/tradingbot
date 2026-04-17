/**
 * GARCH v2 New Pairs Research
 *
 * Download 5m data for candidate HL pairs, run GARCH v2 backtest, rank results.
 * Matches live engine: 1h/4h z-scores, BTC 1h EMA(9/21) filter, pair EMA(9/21),
 * SL 3% (cap 3.5%), TP 7%, max hold 96h, stepped trail 25/6->30/3->35/1.
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-garch-new-pairs.ts
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
const SIZE = 9; // $9 margin (matches live GARCH config)
const NOT = SIZE * LEV; // $90 notional

// GARCH v2 params (matching live engine)
const MOM_LB = 3;
const VOL_WIN = 20;
const Z_LONG_1H = 4.5;
const Z_LONG_4H = 3.0;
const Z_SHORT_1H = -3.0;
const Z_SHORT_4H = -3.0;
const SL_PCT = 0.03;
const SL_CAP = 0.035;
const TP_PCT = 0.07;
const MAX_HOLD_H = 96;

// Stepped trailing (leveraged PnL %)
const TRAIL_STEPS = [
  { activate: 25, dist: 6 },
  { activate: 30, dist: 3 },
  { activate: 35, dist: 1 },
];

// BTC EMA filter (1h, matching live engine)
const BTC_EMA_FAST = 9;
const BTC_EMA_SLOW = 21;

// Spread map (half-spread per side)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.0e-4, SOL: 2.0e-4,
  SUI: 1.85e-4, AVAX: 2.55e-4, TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4,
  UNI: 2.75e-4, APT: 3.2e-4, LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4,
  DOT: 4.95e-4, WIF: 5.05e-4, ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4,
  DASH: 7.15e-4, NEAR: 3.5e-4, FET: 4e-4, HYPE: 4e-4, ZEC: 4e-4,
};
const DEFAULT_SPREAD = 5e-4;

// Current 25 production pairs
const CURRENT_25 = new Set([
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH",
  "TIA", "SOL", "ZEC", "AVAX", "NEAR", "kPEPE", "SUI", "HYPE", "FET",
]);

const DISPLAY_MAP: Record<string, string> = {
  "1000PEPE": "kPEPE",
  "1000FLOKI": "kFLOKI",
  "1000BONK": "kBONK",
  "1000SHIB": "kSHIB",
};

// Candidate pairs to download (popular HL perps not in current set)
const CANDIDATES_TO_DOWNLOAD = [
  "ALGO", "ATOM", "FIL", "HBAR", "ICP", "PENDLE", "PNUT", "POL",
  "POPCAT", "RENDER", "RUNE", "SNX", "STX", "TAO",
  "JUP", "SEI", "TON", "AAVE", "ONDO", "INJ", "SAND", "MANA", "CRV",
  "BNB", "LTC", "BCH", "DYDX", "MKR", "GRT", "IMX", "BLUR", "JTO",
  "TRX", "XLM", "PYTH", "1000FLOKI", "1000BONK", "1000SHIB",
  "RNDR", "1000PEPE",
  // Current pairs missing from 5m cache
  "ZEC", "AVAX", "NEAR", "SUI", "HYPE",
];

// OOS window
const OOS_START = new Date("2025-06-01").getTime();
const OOS_END = new Date("2026-03-25").getTime();

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; }
interface Tr {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string;
}

// ─── Data Download ──────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function download5m(sym: string): Promise<number> {
  const cacheFile = path.join(CACHE_5M, `${sym}.json`);
  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    if (stat.size > 1_000_000) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as any[];
      console.log(`  [cache] ${sym}: ${data.length} candles`);
      return data.length;
    }
  }

  console.log(`  [download] ${sym}: fetching from Binance...`);
  const allCandles: C[] = [];
  const startTime = new Date("2023-01-01").getTime();
  const endTime = new Date("2026-03-28").getTime();
  const chunkMs = 1000 * 5 * 60 * 1000;

  for (let t = startTime; t < endTime; t += chunkMs) {
    const url =
      `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=5m` +
      `&startTime=${t}&limit=1000`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!res.ok) {
        if (res.status === 400) {
          console.log(`  [download] ${sym}: not found on Binance (400)`);
          return 0;
        }
        console.warn(`  [download] ${sym}: HTTP ${res.status}`);
        break;
      }
      const raw = (await res.json()) as unknown[][];
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const r of raw) {
        allCandles.push({
          t: r[0] as number, o: +(r[1] as string),
          h: +(r[2] as string), l: +(r[3] as string), c: +(r[4] as string),
        });
      }
      if (raw.length < 1000) break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  [download] ${sym}: fetch error - ${msg}`);
      break;
    }
    await sleep(80);
  }

  if (allCandles.length === 0) return 0;
  allCandles.sort((a, b) => a.t - b.t);
  fs.writeFileSync(cacheFile, JSON.stringify(allCandles));
  const s = new Date(allCandles[0]!.t).toISOString().slice(0, 10);
  const e = new Date(allCandles[allCandles.length - 1]!.t).toISOString().slice(0, 10);
  console.log(`  [download] ${sym}: ${allCandles.length} candles, ${s} to ${e}`);
  return allCandles.length;
}

// ─── Data Loading & Aggregation ─────────────────────────────────────
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

// ─── BTC 1h EMA(9/21) Filter ────────────────────────────────────────
function buildBtcH1Filter(btcH1: C[]): { bullish: (t: number) => boolean; bearish: (t: number) => boolean } {
  const closes = btcH1.map(c => c.c);
  const ema9 = calcEMA(closes, BTC_EMA_FAST);
  const ema21 = calcEMA(closes, BTC_EMA_SLOW);
  const tsMap = new Map<number, number>();
  btcH1.forEach((c, i) => tsMap.set(c.t, i));

  return {
    bullish: (t: number) => {
      const bucket = Math.floor(t / H) * H;
      const i = tsMap.get(bucket);
      if (i === undefined || i < BTC_EMA_SLOW) return false;
      return ema9[i - 1]! > ema21[i - 1]!; // prev completed bar
    },
    bearish: (t: number) => {
      const bucket = Math.floor(t / H) * H;
      const i = tsMap.get(bucket);
      if (i === undefined || i < BTC_EMA_SLOW) return false;
      return ema9[i - 1]! < ema21[i - 1]!;
    },
  };
}

// ─── GARCH v2 Strategy ──────────────────────────────────────────────
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

function buildPairIndicators(bars5m: C[], emaF = 9, emaS = 21, momLb = MOM_LB, volW = VOL_WIN): PairIndicators {
  const h1 = aggregate(bars5m, H, 10);
  const h4 = aggregate(bars5m, H4, 40);
  const z1h = computeZScores(h1, momLb, volW);
  const z4h = computeZScores(h4, momLb, volW);
  const h1Ema9 = calcEMA(h1.map(c => c.c), emaF);
  const h1Ema21 = calcEMA(h1.map(c => c.c), emaS);
  const h1TsMap = new Map<number, number>();
  h1.forEach((c, i) => h1TsMap.set(c.t, i));
  const h4TsMap = new Map<number, number>();
  h4.forEach((c, i) => h4TsMap.set(c.t, i));
  return { h1, h4, z1h, z4h, h1Ema9, h1Ema21, h1TsMap, h4TsMap };
}

function runGarchV2(
  pair: string,
  ind: PairIndicators,
  btcFilter: { bullish: (t: number) => boolean; bearish: (t: number) => boolean },
  startTs: number,
  endTs: number,
): Tr[] {
  const trades: Tr[] = [];
  const sp = SP[pair] ?? DEFAULT_SPREAD;

  interface Pos {
    dir: "long" | "short"; ep: number; et: number; sl: number; tp: number;
    peakPnlPct: number;
  }
  let pos: Pos | null = null;

  for (let barIdx = VOL_WIN + 2; barIdx < ind.h1.length; barIdx++) {
    const bar = ind.h1[barIdx]!;
    const prev = barIdx - 1;

    // ─── EXIT checks ───
    if (pos) {
      // Max hold
      const hoursHeld = (bar.t - pos.et) / H;
      if (hoursHeld >= MAX_HOLD_H) {
        const xp = bar.c;
        const pnl = calcPnl(pos.dir, pos.ep, xp, sp, false);
        if (pos.et >= startTs && pos.et < endTs) {
          trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason: "maxh" });
        }
        pos = null;
      }

      if (pos) {
        // SL check (within bar)
        const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
        if (slHit) {
          const xp = pos.sl;
          const pnl = calcPnl(pos.dir, pos.ep, xp, sp, true);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason: "sl" });
          }
          pos = null;
        }
      }

      if (pos) {
        // TP check
        const tpHit = pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp;
        if (tpHit) {
          const xp = pos.tp;
          const pnl = calcPnl(pos.dir, pos.ep, xp, sp, false);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason: "tp" });
          }
          pos = null;
        }
      }

      if (pos) {
        // Update peak
        const best = pos.dir === "long"
          ? (bar.h / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.l - 1) * LEV * 100;
        if (best > pos.peakPnlPct) pos.peakPnlPct = best;

        // Stepped trailing stop
        const curr = pos.dir === "long"
          ? (bar.c / pos.ep - 1) * LEV * 100
          : (pos.ep / bar.c - 1) * LEV * 100;

        let trailDist = Infinity;
        for (const step of TRAIL_STEPS) {
          if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
        }
        if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
          const xp = bar.c;
          const pnl = calcPnl(pos.dir, pos.ep, xp, sp, false);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason: "trail" });
          }
          pos = null;
        }
      }
    }

    // ─── ENTRY checks (1h boundary) ───
    if (!pos && bar.t >= startTs && bar.t < endTs) {
      const z1h = ind.z1h[prev]!;
      const z4h = getLatest4hZ(ind, bar.t);

      const pairEma9 = ind.h1Ema9[prev]!;
      const pairEma21 = ind.h1Ema21[prev]!;

      let dir: "long" | "short" | null = null;

      // Long: 1h z > 4.5, 4h z > 3.0, pair EMA(9) > EMA(21), BTC bullish
      if (z1h > Z_LONG_1H && z4h > Z_LONG_4H && pairEma9 > pairEma21 && btcFilter.bullish(bar.t)) {
        dir = "long";
      }
      // Short: 1h z < -3.0, 4h z < -3.0, pair EMA(9) < EMA(21)
      // BTC filter for shorts (EMA bearish)
      if (z1h < Z_SHORT_1H && z4h < Z_SHORT_4H && pairEma9 < pairEma21 && btcFilter.bearish(bar.t)) {
        dir = "short";
      }

      if (dir) {
        const ep = dir === "long" ? bar.o * (1 + sp) : bar.o * (1 - sp);
        const rawSlDist = ep * SL_PCT;
        const maxSlDist = ep * SL_CAP;
        const slDist = Math.min(rawSlDist, maxSlDist);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        const tp = dir === "long" ? ep * (1 + TP_PCT) : ep * (1 - TP_PCT);
        pos = { dir, ep, et: bar.t, sl, tp, peakPnlPct: 0 };
      }
    }
  }

  // Close open position at end
  if (pos && pos.et >= startTs && pos.et < endTs) {
    const lastBar = ind.h1[ind.h1.length - 1]!;
    const pnl = calcPnl(pos.dir, pos.ep, lastBar.c, sp, false);
    trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
  }

  return trades;
}

function getLatest4hZ(ind: PairIndicators, t: number): number {
  const bucket = Math.floor(t / H4) * H4;
  // Find the latest completed 4h bar at or before this time
  let idx = ind.h4TsMap.get(bucket);
  if (idx !== undefined && idx > 0) return ind.z4h[idx - 1]!;
  // Binary search fallback
  let lo = 0, hi = ind.h4.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ind.h4[mid]!.t < t) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best >= 0 ? ind.z4h[best]! : 0;
}

function calcPnl(dir: "long" | "short", ep: number, xp: number, sp: number, isSL: boolean): number {
  const slip = isSL ? sp * 1.5 : sp;
  const exitPx = dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
  const raw = dir === "long" ? (exitPx / ep - 1) * NOT : (ep / exitPx - 1) * NOT;
  return raw - NOT * FEE * 2;
}

// ─── Metrics ────────────────────────────────────────────────────────
interface Metrics {
  n: number; wr: number; pf: number;
  dd: number; total: number; perDay: number;
  longs: number; shorts: number; avgHold: number;
}

function calcMetrics(trades: Tr[], startTs: number, endTs: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, dd: 0, total: 0, perDay: 0, longs: 0, shorts: 0, avgHold: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const longs = trades.filter(t => t.dir === "long").length;
  const shorts = trades.filter(t => t.dir === "short").length;
  const avgHold = trades.reduce((s, t) => s + (t.xt - t.et), 0) / trades.length / H;

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const days = (endTs - startTs) / D;
  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    dd: maxDD,
    total,
    perDay: days > 0 ? total / days : 0,
    longs,
    shorts,
    avgHold,
  };
}

function fmtPnl(v: number): string {
  return (v >= 0 ? "+" : "-") + "$" + Math.abs(v).toFixed(2);
}

// ═══════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════
async function main() {
  console.log("=".repeat(100));
  console.log("  GARCH v2 NEW PAIRS RESEARCH");
  console.log("  1h/4h z-scores | BTC 1h EMA(9/21) | Pair EMA(9/21) | SL 3% TP 7% | Trail 25/6->30/3->35/1");
  console.log("  $9 margin, 10x lev, 0.035% taker, max hold 96h");
  console.log("  OOS: 2025-06-01 to 2026-03-25");
  console.log("=".repeat(100));

  fs.mkdirSync(CACHE_5M, { recursive: true });

  // ─── Phase 1: Download missing pairs ────────────────────────────
  console.log("\n--- PHASE 1: Download missing 5m candle data ---\n");
  for (const pair of CANDIDATES_TO_DOWNLOAD) {
    const sym = `${pair}USDT`;
    await download5m(sym);
  }

  // ─── Phase 2: Load BTC + all pairs, run GARCH v2 ────────────────
  console.log("\n--- PHASE 2: Run GARCH v2 backtest ---\n");

  const btc5m = load5m("BTCUSDT");
  const btcH1 = aggregate(btc5m, H, 10);
  console.log(`  BTC: ${btc5m.length} 5m -> ${btcH1.length} 1h bars`);
  const btcFilter = buildBtcH1Filter(btcH1);

  const cacheFiles = fs.readdirSync(CACHE_5M).filter(f => f.endsWith(".json"));
  const allSymbols: string[] = [];
  for (const f of cacheFiles) {
    const sym = f.replace("USDT.json", "");
    if (sym === "BTC") continue;
    allSymbols.push(sym);
  }
  allSymbols.sort();

  function displayName(sym: string): string { return DISPLAY_MAP[sym] ?? sym; }

  const newPairs: string[] = [];
  const currentPairs: string[] = [];
  for (const sym of allSymbols) {
    const dn = displayName(sym);
    if (CURRENT_25.has(dn) || CURRENT_25.has(sym)) currentPairs.push(sym);
    else newPairs.push(sym);
  }

  console.log(`  Current pairs: ${currentPairs.length} | New candidates: ${newPairs.length}\n`);

  interface PairResult {
    pair: string; display: string; h1Bars: number; h4Bars: number;
    metrics: Metrics; isNew: boolean; exits: Map<string, number>;
  }

  const results: PairResult[] = [];
  const oosDays = (OOS_END - OOS_START) / D;

  for (const sym of [...currentPairs, ...newPairs]) {
    const raw5m = load5m(`${sym}USDT`);
    if (raw5m.length < 5000) {
      console.log(`  SKIP ${sym}: only ${raw5m.length} 5m bars`);
      continue;
    }

    const dn = displayName(sym);
    const ind = buildPairIndicators(raw5m);
    if (ind.h1.length < 100 || ind.h4.length < 50) {
      console.log(`  SKIP ${dn}: too few bars (${ind.h1.length} 1h, ${ind.h4.length} 4h)`);
      continue;
    }

    const trades = runGarchV2(dn, ind, btcFilter, OOS_START, OOS_END);
    const metrics = calcMetrics(trades, OOS_START, OOS_END);

    const exits = new Map<string, number>();
    for (const t of trades) exits.set(t.reason, (exits.get(t.reason) ?? 0) + 1);

    const isNew = !CURRENT_25.has(dn) && !CURRENT_25.has(sym);
    results.push({ pair: sym, display: dn, h1Bars: ind.h1.length, h4Bars: ind.h4.length, metrics, isNew, exits });

    const tag = isNew ? "NEW" : "CUR";
    if (metrics.n > 0) {
      console.log(
        `  [${tag}] ${dn.padEnd(12)} N=${String(metrics.n).padStart(3)} `
        + `WR=${metrics.wr.toFixed(1).padStart(5)}% PF=${(metrics.pf === Infinity ? " Inf" : metrics.pf.toFixed(2)).padStart(5)} `
        + `PnL=${fmtPnl(metrics.total).padStart(9)} $/d=${fmtPnl(metrics.perDay).padStart(7)} `
        + `DD=$${metrics.dd.toFixed(0).padStart(4)} Hold=${metrics.avgHold.toFixed(0)}h`
      );
    } else {
      console.log(`  [${tag}] ${dn.padEnd(12)} no trades in OOS window`);
    }
  }

  // ─── Phase 3: Rankings ─────────────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("  CURRENT PAIRS (GARCH v2)");
  console.log("=".repeat(100));

  const curResults = results.filter(r => !r.isNew && r.metrics.n > 0);
  curResults.sort((a, b) => b.metrics.pf - a.metrics.pf);

  const hdr = "  " + "Pair".padEnd(10) + "Trades".padStart(7) + " L/S".padStart(7)
    + "   WR%".padStart(7) + "    PF".padStart(7) + "     PnL".padStart(10)
    + "   $/day".padStart(9) + "  MaxDD".padStart(8) + " AvgH".padStart(6)
    + "  SL".padStart(5) + "  TP".padStart(5) + " Trail".padStart(6) + " MaxH".padStart(5);

  console.log("\n" + hdr);
  console.log("  " + "-".repeat(110));

  for (const r of curResults) {
    const m = r.metrics;
    const slN = r.exits.get("sl") ?? 0;
    const tpN = r.exits.get("tp") ?? 0;
    const trN = r.exits.get("trail") ?? 0;
    const mhN = r.exits.get("maxh") ?? 0;
    console.log(
      "  " + r.display.padEnd(10)
      + String(m.n).padStart(7)
      + `  ${m.longs}/${m.shorts}`.padStart(7)
      + ("  " + m.wr.toFixed(1) + "%").padStart(7)
      + ("  " + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2))).padStart(7)
      + ("  " + fmtPnl(m.total)).padStart(10)
      + ("  " + fmtPnl(m.perDay)).padStart(9)
      + ("  $" + m.dd.toFixed(0)).padStart(8)
      + (" " + m.avgHold.toFixed(0) + "h").padStart(6)
      + String(slN).padStart(5)
      + String(tpN).padStart(5)
      + String(trN).padStart(6)
      + String(mhN).padStart(5)
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("  NEW PAIR CANDIDATES (ranked by PF)");
  console.log("=".repeat(100));

  const newResults = results.filter(r => r.isNew && r.metrics.n > 0);
  newResults.sort((a, b) => b.metrics.pf - a.metrics.pf);

  const hdr2 = "  " + "Pair".padEnd(10) + "Trades".padStart(7) + " L/S".padStart(7)
    + "   WR%".padStart(7) + "    PF".padStart(7) + "     PnL".padStart(10)
    + "   $/day".padStart(9) + "  MaxDD".padStart(8) + " AvgH".padStart(6)
    + "  SL".padStart(5) + "  TP".padStart(5) + " Trail".padStart(6) + " MaxH".padStart(5) + "  Verdict";

  console.log("\n" + hdr2);
  console.log("  " + "-".repeat(110));

  for (const r of newResults) {
    const m = r.metrics;
    let verdict = "SKIP";
    if (m.pf > 1.3 && m.perDay > 0 && m.n >= 3) verdict = "ADD";
    else if (m.pf > 1.1 && m.perDay > 0 && m.n >= 3) verdict = "MAYBE";
    else if (m.total > 0) verdict = "WEAK";

    const slN = r.exits.get("sl") ?? 0;
    const tpN = r.exits.get("tp") ?? 0;
    const trN = r.exits.get("trail") ?? 0;
    const mhN = r.exits.get("maxh") ?? 0;

    console.log(
      "  " + r.display.padEnd(10)
      + String(m.n).padStart(7)
      + `  ${m.longs}/${m.shorts}`.padStart(7)
      + ("  " + m.wr.toFixed(1) + "%").padStart(7)
      + ("  " + (m.pf === Infinity ? "  Inf" : m.pf.toFixed(2))).padStart(7)
      + ("  " + fmtPnl(m.total)).padStart(10)
      + ("  " + fmtPnl(m.perDay)).padStart(9)
      + ("  $" + m.dd.toFixed(0)).padStart(8)
      + (" " + m.avgHold.toFixed(0) + "h").padStart(6)
      + String(slN).padStart(5)
      + String(tpN).padStart(5)
      + String(trN).padStart(6)
      + String(mhN).padStart(5)
      + "  " + verdict
    );
  }

  const zeroTrades = results.filter(r => r.isNew && r.metrics.n === 0);
  if (zeroTrades.length > 0) {
    console.log(`\n  Zero trades: ${zeroTrades.map(r => r.display).join(", ")}`);
  }

  // ─── Recommendations ──────────────────────────────────────────
  console.log("\n" + "=".repeat(100));
  console.log("  RECOMMENDATIONS");
  console.log("=".repeat(100));

  const recommended = newResults.filter(r => r.metrics.pf > 1.3 && r.metrics.perDay > 0 && r.metrics.n >= 3);
  recommended.sort((a, b) => b.metrics.perDay - a.metrics.perDay);

  if (recommended.length === 0) {
    console.log("\n  No new pairs meet criteria (PF > 1.3, positive $/day, N >= 3).");
  } else {
    console.log("\n  ADD (PF > 1.3, N >= 3):");
    for (const r of recommended) {
      const m = r.metrics;
      console.log(
        `    ${r.display.padEnd(10)} PF=${m.pf.toFixed(2).padStart(5)} $/d=${fmtPnl(m.perDay).padStart(7)} `
        + `WR=${m.wr.toFixed(1).padStart(5)}% N=${String(m.n).padStart(3)} DD=$${m.dd.toFixed(0).padStart(4)}`
      );
    }
  }

  const maybe = newResults.filter(r => r.metrics.pf > 1.1 && r.metrics.perDay > 0 && r.metrics.n >= 3 && r.metrics.pf <= 1.3);
  if (maybe.length > 0) {
    console.log("\n  MAYBE (PF 1.1-1.3, N >= 3):");
    for (const r of maybe) {
      const m = r.metrics;
      console.log(
        `    ${r.display.padEnd(10)} PF=${m.pf.toFixed(2).padStart(5)} $/d=${fmtPnl(m.perDay).padStart(7)} `
        + `WR=${m.wr.toFixed(1).padStart(5)}% N=${String(m.n).padStart(3)} DD=$${m.dd.toFixed(0).padStart(4)}`
      );
    }
  }

  // Summary
  const curTotal = curResults.reduce((s, r) => s + r.metrics.total, 0);
  const curPerDay = curTotal / oosDays;
  const addTotal = recommended.reduce((s, r) => s + r.metrics.total, 0);
  const addPerDay = addTotal / oosDays;

  console.log("\n  Summary:");
  console.log(`    Current 25 pairs: ${fmtPnl(curTotal)} total (${fmtPnl(curPerDay)}/day)`);
  if (recommended.length > 0) {
    console.log(`    New pairs add:    ${fmtPnl(addTotal)} total (${fmtPnl(addPerDay)}/day)`);
    console.log(`    Combined:         ${fmtPnl(curTotal + addTotal)} total (${fmtPnl(curPerDay + addPerDay)}/day)`);
    console.log(`\n    Proposed additions: ${recommended.map(r => r.display).join(", ")}`);
  }

  // ─── Phase 4: Unified Portfolio Backtest (max 7 concurrent) ─────
  console.log("\n" + "=".repeat(100));
  console.log("  UNIFIED PORTFOLIO BACKTEST (no position limit)");
  console.log("  Simulates hour-by-hour: signals checked, all valid entries taken");
  console.log("=".repeat(100));

  function runUnifiedPortfolio(pairNames: string[], label: string, opts?: {
    tp?: number; sl?: number; slCap?: number; maxPos?: number;
    trail?: { activate: number; dist: number }[]; margin?: number;
    blockHours?: number[]; onlyDir?: "long" | "short";
    zLong1h?: number; zLong4h?: number; zShort1h?: number; zShort4h?: number;
    maxHoldH?: number; slCooldownH?: number;
    breakevenAt?: number;
    emaFast?: number; emaSlow?: number; noEmaFilter?: boolean; noBtcFilter?: boolean;
    momLb?: number; volWin?: number;
  }) {
    const MAX_CONCURRENT = opts?.maxPos ?? 999;
    const SL_COOLDOWN_H = opts?.slCooldownH ?? 2;
    const tpPct = opts?.tp ?? 0;
    const slPct = opts?.sl ?? SL_PCT;
    const slCapPct = opts?.slCap ?? SL_CAP;
    const trailSteps = opts?.trail ?? TRAIL_STEPS;
    const notional = (opts?.margin ?? SIZE) * LEV;

    // Build indicators for all pairs
    interface PairData { name: string; ind: PairIndicators; sp: number; }
    const pairs: PairData[] = [];
    for (const name of pairNames) {
      // Find the raw symbol (may need reverse lookup from display name)
      const sym = Object.entries(DISPLAY_MAP).find(([, v]) => v === name)?.[0] ?? name;
      const raw5m = load5m(`${sym}USDT`);
      if (raw5m.length < 5000) continue;
      const ind = buildPairIndicators(raw5m, opts?.emaFast ?? 9, opts?.emaSlow ?? 21, opts?.momLb ?? MOM_LB, opts?.volWin ?? VOL_WIN);
      if (ind.h1.length < 100 || ind.h4.length < 50) continue;
      pairs.push({ name, ind, sp: SP[name] ?? DEFAULT_SPREAD });
    }

    // Find common 1h time range (OOS only)
    const allH1Times: number[] = [];
    for (const p of pairs) {
      for (const bar of p.ind.h1) {
        if (bar.t >= OOS_START && bar.t < OOS_END) allH1Times.push(bar.t);
      }
    }
    const uniqueHours = [...new Set(allH1Times)].sort((a, b) => a - b);

    // Open positions state
    interface OpenPos {
      pair: string; dir: "long" | "short"; ep: number; et: number;
      sl: number; tp: number; peakPnlPct: number; sp: number;
    }
    const openPositions: OpenPos[] = [];
    const closedTrades: Tr[] = [];
    let skippedSignals = 0;
    // Cooldown: key = "PAIR:long" or "PAIR:short", value = cooldown-until timestamp
    const cooldowns = new Map<string, number>();

    for (const hour of uniqueHours) {
      // ─── EXIT all open positions that trigger this bar ───
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i]!;
        // Find this pair's 1h bar at this hour
        const pairData = pairs.find(p => p.name === pos.pair);
        if (!pairData) continue;
        const barIdx = pairData.ind.h1TsMap.get(hour);
        if (barIdx === undefined) continue;
        const bar = pairData.ind.h1[barIdx]!;

        let xp = 0, reason = "", isSL = false;

        // Max hold
        const maxHold = opts?.maxHoldH ?? MAX_HOLD_H;
        const hoursHeld = (hour - pos.et) / H;
        if (hoursHeld >= maxHold) {
          xp = bar.c; reason = "maxh";
        }

        // Breakeven stop: if peak ever reached breakevenAt%, move SL to entry
        if (!xp && opts?.breakevenAt && pos.peakPnlPct >= opts.breakevenAt) {
          const beSl = pos.ep; // entry price = breakeven
          const beHit = pos.dir === "long" ? bar.l <= beSl : bar.h >= beSl;
          if (beHit) { xp = beSl; reason = "be"; }
        }

        // SL (only if breakeven not triggered)
        if (!xp) {
          const slHit = pos.dir === "long" ? bar.l <= pos.sl : bar.h >= pos.sl;
          if (slHit) { xp = pos.sl; reason = "sl"; isSL = true; }
        }

        // TP (skip if tp=0, meaning no TP)
        if (!xp && pos.tp > 0) {
          const tpHit = pos.dir === "long" ? bar.h >= pos.tp : bar.l <= pos.tp;
          if (tpHit) { xp = pos.tp; reason = "tp"; }
        }

        // Update peak
        if (!xp) {
          const best = pos.dir === "long"
            ? (bar.h / pos.ep - 1) * LEV * 100
            : (pos.ep / bar.l - 1) * LEV * 100;
          if (best > pos.peakPnlPct) pos.peakPnlPct = best;

          // Stepped trailing
          const curr = pos.dir === "long"
            ? (bar.c / pos.ep - 1) * LEV * 100
            : (pos.ep / bar.c - 1) * LEV * 100;
          let trailDist = Infinity;
          for (const step of trailSteps) {
            if (pos.peakPnlPct >= step.activate) trailDist = step.dist;
          }
          if (trailDist < Infinity && curr <= pos.peakPnlPct - trailDist) {
            xp = bar.c; reason = "trail";
          }
        }

        if (xp > 0) {
          const slip = isSL ? pos.sp * 1.5 : pos.sp;
          const exitPx = pos.dir === "long" ? xp * (1 - slip) : xp * (1 + slip);
          const raw = pos.dir === "long" ? (exitPx / pos.ep - 1) * notional : (pos.ep / exitPx - 1) * notional;
          const pnl = raw - notional * FEE * 2;
          closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: hour, pnl, reason });
          openPositions.splice(i, 1);
          // Set cooldown on SL
          if (reason === "sl") {
            cooldowns.set(`${pos.pair}:${pos.dir}`, hour + SL_COOLDOWN_H * H);
          }
        }
      }

      // ─── ENTRY: check all pairs for signals, enforce position limit ───
      if (openPositions.length >= MAX_CONCURRENT) continue; // no room
      const hourOfDay = new Date(hour).getUTCHours();
      if (opts?.blockHours?.includes(hourOfDay)) continue; // blocked hour

      // Collect all signals this hour, sort by z-score strength (best first)
      interface Signal { pair: string; dir: "long" | "short"; z1h: number; z4h: number; ep: number; sl: number; tp: number; sp: number; }
      const signals: Signal[] = [];

      for (const p of pairs) {
        const barIdx = p.ind.h1TsMap.get(hour);
        if (barIdx === undefined || barIdx < VOL_WIN + 2) continue;
        const bar = p.ind.h1[barIdx]!;
        const prev = barIdx - 1;

        // Skip if already have position in this pair
        if (openPositions.some(op => op.pair === p.name)) continue;

        const z1h = p.ind.z1h[prev]!;
        const z4h = getLatest4hZ(p.ind, hour);
        const pairEma9 = p.ind.h1Ema9[prev]!;
        const pairEma21 = p.ind.h1Ema21[prev]!;

        const zL1h = opts?.zLong1h ?? Z_LONG_1H;
        const zL4h = opts?.zLong4h ?? Z_LONG_4H;
        const zS1h = opts?.zShort1h ?? Z_SHORT_1H;
        const zS4h = opts?.zShort4h ?? Z_SHORT_4H;

        const emaOk = opts?.noEmaFilter ? true : undefined;
        const btcOk = opts?.noBtcFilter ? true : undefined;

        let dir: "long" | "short" | null = null;
        if (z1h > zL1h && z4h > zL4h && (emaOk || pairEma9 > pairEma21) && (btcOk || btcFilter.bullish(hour))) {
          dir = "long";
        }
        if (z1h < zS1h && z4h < zS4h && (emaOk || pairEma9 < pairEma21) && (btcOk || btcFilter.bearish(hour))) {
          dir = "short";
        }
        if (!dir) continue;
        if (opts?.onlyDir && dir !== opts.onlyDir) continue;

        // Check cooldown
        const cdKey = `${p.name}:${dir}`;
        const cdUntil = cooldowns.get(cdKey);
        if (cdUntil && hour < cdUntil) continue;

        const ep = dir === "long" ? bar.o * (1 + p.sp) : bar.o * (1 - p.sp);
        const rawSlDist = ep * slPct;
        const maxSlDist = ep * slCapPct;
        const slDist = Math.min(rawSlDist, maxSlDist);
        const sl = dir === "long" ? ep - slDist : ep + slDist;
        const tp = tpPct > 0 ? (dir === "long" ? ep * (1 + tpPct) : ep * (1 - tpPct)) : 0;

        signals.push({ pair: p.name, dir, z1h, z4h, ep, sl, tp, sp: p.sp });
      }

      // Sort by z-score magnitude (strongest signal first, like live scheduler would prioritize)
      signals.sort((a, b) => Math.abs(b.z1h) - Math.abs(a.z1h));

      for (const sig of signals) {
        if (openPositions.length >= MAX_CONCURRENT) {
          skippedSignals++;
          continue;
        }
        openPositions.push({
          pair: sig.pair, dir: sig.dir, ep: sig.ep, et: hour,
          sl: sig.sl, tp: sig.tp, peakPnlPct: 0, sp: sig.sp,
        });
      }
    }

    // Close remaining open positions at end
    for (const pos of openPositions) {
      const pairData = pairs.find(p => p.name === pos.pair);
      if (!pairData) continue;
      const lastBar = pairData.ind.h1[pairData.ind.h1.length - 1]!;
      const raw = pos.dir === "long" ? (lastBar.c / pos.ep - 1) * notional : (pos.ep / lastBar.c - 1) * notional;
      const pnl = raw - notional * FEE * 2;
      closedTrades.push({ pair: pos.pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end" });
    }

    // Calculate stats
    const sorted = [...closedTrades].sort((a, b) => a.xt - b.xt);
    let cum = 0, peak = 0, maxDD = 0;
    for (const t of sorted) {
      cum += t.pnl;
      if (cum > peak) peak = cum;
      if (peak - cum > maxDD) maxDD = peak - cum;
    }

    const totalPnl = sorted.reduce((s, t) => s + t.pnl, 0);
    const wins = sorted.filter(t => t.pnl > 0).length;
    const wr = sorted.length > 0 ? (wins / sorted.length * 100) : 0;
    const grossProfit = sorted.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(sorted.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
    const tradesPerDay = sorted.length / oosDays;

    const slCount = sorted.filter(t => t.reason === "sl").length;
    const beCount = sorted.filter(t => t.reason === "be").length;
    const tpCount = sorted.filter(t => t.reason === "tp").length;
    const trailCount = sorted.filter(t => t.reason === "trail").length;
    const maxhCount = sorted.filter(t => t.reason === "maxh").length;
    const endCount = sorted.filter(t => t.reason === "end").length;

    // Per-pair breakdown
    const pairStats = new Map<string, { n: number; pnl: number }>();
    for (const t of sorted) {
      const s = pairStats.get(t.pair) ?? { n: 0, pnl: 0 };
      s.n++; s.pnl += t.pnl;
      pairStats.set(t.pair, s);
    }

    // Compact one-line output for sweep mode
    console.log(
      "  " + label.padEnd(8)
      + String(sorted.length).padStart(7)
      + (" " + tradesPerDay.toFixed(2)).padStart(7)
      + ("  " + wr.toFixed(1) + "%").padStart(7)
      + ("  " + pf.toFixed(2)).padStart(7)
      + ("  " + fmtPnl(totalPnl)).padStart(10)
      + ("  " + fmtPnl(totalPnl / oosDays)).padStart(9)
      + ("  $" + maxDD.toFixed(0)).padStart(8)
      + String(slCount).padStart(5)
      + String(beCount).padStart(5)
      + String(trailCount).padStart(6)
      + String(maxhCount).padStart(5)
    );

    // Drawdown analysis: track DD over time for deep-dive configs
    if (label.includes("DEEP")) {
      // Build daily equity curve
      const dailyPnl = new Map<number, number>();
      for (const t of sorted) {
        const day = Math.floor(t.xt / D) * D;
        dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + t.pnl);
      }
      const days = [...dailyPnl.entries()].sort((a, b) => a[0] - b[0]);

      let eqCum = 0, eqPeak = 0;
      const ddHistory: { date: string; dd: number; eq: number }[] = [];
      for (const [day, pnl] of days) {
        eqCum += pnl;
        if (eqCum > eqPeak) eqPeak = eqCum;
        const dd = eqPeak - eqCum;
        ddHistory.push({ date: new Date(day).toISOString().slice(0, 10), dd, eq: eqCum });
      }

      // Count days in DD brackets
      const brackets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
      const counts = brackets.map(b => ddHistory.filter(d => d.dd >= b).length);
      console.log(`    DD frequency (of ${ddHistory.length} trading days):`);
      console.log(`      ${brackets.map(b => `>$${b}`).join("  ")}`);
      console.log(`      ${counts.map(c => String(c).padStart(String(brackets[0]).length + 1)).join("  ")}`);

      // Worst 5 DD days
      const worst = [...ddHistory].sort((a, b) => b.dd - a.dd).slice(0, 5);
      console.log(`    Worst DD days: ${worst.map(d => `${d.date}($${d.dd.toFixed(0)})`).join(", ")}`);

      // Consecutive losing streaks
      let streak = 0, maxStreak = 0, streakPnl = 0, maxStreakPnl = 0;
      for (const t of sorted) {
        if (t.pnl < 0) {
          streak++; streakPnl += t.pnl;
          if (streak > maxStreak) { maxStreak = streak; maxStreakPnl = streakPnl; }
        } else {
          streak = 0; streakPnl = 0;
        }
      }
      console.log(`    Max losing streak: ${maxStreak} trades (${fmtPnl(maxStreakPnl)})`);

      // Time to recover from MaxDD
      let inDD = false, ddStart = 0, recoveryDays = 0;
      eqCum = 0; eqPeak = 0;
      for (const [day, pnl] of days) {
        eqCum += pnl;
        if (eqCum > eqPeak) { eqPeak = eqCum; inDD = false; }
        const dd = eqPeak - eqCum;
        if (dd >= maxDD * 0.95 && !inDD) { inDD = true; ddStart = day; }
        if (inDD && dd < maxDD * 0.1) { recoveryDays = (day - ddStart) / D; inDD = false; }
      }
      if (recoveryDays > 0) console.log(`    Recovery from MaxDD: ~${recoveryDays.toFixed(0)} days`);
      console.log("");
    }
  }

  const curNames = curResults.map(r => r.display);
  const addNames = results.filter(r => r.isNew && r.metrics.pf > 1.3 && r.metrics.perDay > 0 && r.metrics.n >= 3).map(r => r.display);
  const maybeNames = results.filter(r => r.isNew && r.metrics.pf > 1.1 && r.metrics.perDay > 0 && r.metrics.n >= 3 && r.metrics.pf <= 1.3).map(r => r.display);
  const allNames = [...curNames, ...addNames];
  const allPlusMaybe = [...allNames, ...maybeNames];

  // Current deployed config
  const deployedTrail = [{ activate: 10, dist: 5 }, { activate: 15, dist: 4 }, { activate: 20, dist: 3 }, { activate: 25, dist: 2 }, { activate: 35, dist: 1.5 }, { activate: 50, dist: 1 }];
  const liveOpts = { sl: 0.01, slCap: 0.015, margin: 5, blockHours: [22, 23], trail: deployedTrail, slCooldownH: 1, breakevenAt: 3 };
  const sweepHdr = "  " + "Config".padEnd(45) + "Trades".padStart(7) + " Tr/d".padStart(6)
    + "  WR%".padStart(6) + "   PF".padStart(6) + "     PnL".padStart(10)
    + "  $/day".padStart(8) + " MaxDD".padStart(7)
    + "  SL".padStart(5) + "  BE".padStart(5) + " Trail".padStart(6);

  // All 53 pairs (current deployed set)
  const maybePairsHL = ["PENDLE", "PNUT", "ATOM", "TON", "SEI", "STX"];
  const all53 = [...allNames, ...maybePairsHL];

  // Z-score sweep with DEPLOYED config (SL 1%, BE +3%, trail 10/5, block h22-23)
  console.log(`\n  Z-SCORE SWEEP (${all53.length} pairs, SL 1%, BE +3%, trail 10/5, block h22-23)\n`);
  console.log(sweepHdr);
  console.log("  " + "-".repeat(115));

  // Actual deployed config: SL 0.5%, z 3.0/2.5 -3.0/-2.5
  const deployedOpts = { sl: 0.005, slCap: 0.01, margin: 5, blockHours: [22, 23], trail: deployedTrail, slCooldownH: 1, breakevenAt: 3, zLong1h: 3.0, zLong4h: 2.5, zShort1h: -3.0, zShort4h: -2.5 };

  console.log(`\n  FINAL OPTIMIZATION (53p, SL 0.5%, z 3.0/2.5 -3.0/-2.5, BE +3%)\n`);
  console.log(sweepHdr);
  console.log("  " + "-".repeat(115));

  // Baseline
  runUnifiedPortfolio(all53, "DEEP Deployed baseline               ", deployedOpts);

  // 1. Filters -- what if we remove them?
  runUnifiedPortfolio(all53, "DEEP No EMA filter                   ", { ...deployedOpts, noEmaFilter: true });
  runUnifiedPortfolio(all53, "DEEP No BTC filter                   ", { ...deployedOpts, noBtcFilter: true });
  runUnifiedPortfolio(all53, "DEEP No EMA + No BTC                 ", { ...deployedOpts, noEmaFilter: true, noBtcFilter: true });

  // 2. EMA periods
  runUnifiedPortfolio(all53, "DEEP EMA 5/13                        ", { ...deployedOpts, emaFast: 5, emaSlow: 13 });
  runUnifiedPortfolio(all53, "DEEP EMA 7/21                        ", { ...deployedOpts, emaFast: 7, emaSlow: 21 });
  runUnifiedPortfolio(all53, "DEEP EMA 12/26                       ", { ...deployedOpts, emaFast: 12, emaSlow: 26 });

  // 3. GARCH params
  runUnifiedPortfolio(all53, "DEEP MomLB=2 VolWin=15               ", { ...deployedOpts, momLb: 2, volWin: 15 });
  runUnifiedPortfolio(all53, "DEEP MomLB=2 VolWin=20               ", { ...deployedOpts, momLb: 2 });
  runUnifiedPortfolio(all53, "DEEP MomLB=5 VolWin=20               ", { ...deployedOpts, momLb: 5 });

  // 4. BE threshold with SL 0.5%
  runUnifiedPortfolio(all53, "DEEP BE +2%                          ", { ...deployedOpts, breakevenAt: 2 });
  runUnifiedPortfolio(all53, "DEEP BE +1.5%                        ", { ...deployedOpts, breakevenAt: 1.5 });
  runUnifiedPortfolio(all53, "DEEP BE +4%                          ", { ...deployedOpts, breakevenAt: 4 });
  runUnifiedPortfolio(all53, "DEEP No BE                           ", { ...deployedOpts, breakevenAt: undefined });

  // 5. Margin size (maybe $3 with more trades = more $?)
  runUnifiedPortfolio(all53, "DEEP $3 margin                       ", { ...deployedOpts, margin: 3 });
  runUnifiedPortfolio(all53, "DEEP $7 margin                       ", { ...deployedOpts, margin: 7 });

  // 6. Asymmetric: different SL for longs vs shorts (hack: just test short-only with different SL)
  runUnifiedPortfolio(all53, "DEEP Short-only SL 0.5%              ", { ...deployedOpts, onlyDir: "short" as const });
  runUnifiedPortfolio(all53, "DEEP Long-only SL 0.5%               ", { ...deployedOpts, onlyDir: "long" as const });

  // 7. Block more/fewer hours
  runUnifiedPortfolio(all53, "DEEP Block h22 only                  ", { ...deployedOpts, blockHours: [22] });
  runUnifiedPortfolio(all53, "DEEP Block h21-23                    ", { ...deployedOpts, blockHours: [21, 22, 23] });
  runUnifiedPortfolio(all53, "DEEP No hour block                   ", { ...deployedOpts, blockHours: [] });

  // 8. Combos of best findings
  runUnifiedPortfolio(all53, "DEEP No EMA + BE +2%                 ", { ...deployedOpts, noEmaFilter: true, breakevenAt: 2 });
  runUnifiedPortfolio(all53, "DEEP No BTC + BE +2%                 ", { ...deployedOpts, noBtcFilter: true, breakevenAt: 2 });

  // Just the top 3 with DD analysis
  runUnifiedPortfolio(all53, "DEEP $7 + noBTC + BE2%               ", { ...deployedOpts, margin: 7, noBtcFilter: true, breakevenAt: 2 });
  runUnifiedPortfolio(all53, "DEEP $7 + noEMA + noBTC + BE2%       ", { ...deployedOpts, margin: 7, noEmaFilter: true, noBtcFilter: true, breakevenAt: 2 });
  runUnifiedPortfolio(all53, "DEEP $5 deployed baseline            ", deployedOpts);

  console.log("\n" + "=".repeat(115));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
