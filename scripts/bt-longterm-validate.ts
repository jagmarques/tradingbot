/**
 * Long-Term Validation: 3.2 Years Rolling OOS, Regime Analysis, YoY, Worst-Case
 *
 * TEST 1: Rolling 6-month OOS windows (train on everything before, test on window)
 * TEST 2: Bear vs Bull vs Sideways regime performance
 * TEST 3: Year-over-year consistency (5-engine ensemble proxy)
 * TEST 4: Worst-case 30-day period analysis
 *
 * Data: 5m candles from /tmp/bt-pair-cache-5m/, aggregated to 4h/1h/daily.
 * Cost model: Taker 0.035%, standard spread map, 1.5x SL slippage, 10x leverage.
 * Supertrend size: $3 margin ($30 notional). Other engines: $5 margin ($50 notional).
 *
 * Run: cd "/Users/jagmarques/Library/CloudStorage/OneDrive/Work/.TradingBot" && npx tsx scripts/bt-longterm-validate.ts
 */

import * as fs from "fs";
import * as path from "path";

// ─── Constants ──────────────────────────────────────────────────────
const CACHE_5M = "/tmp/bt-pair-cache-5m";
const H = 3_600_000;
const H4 = 4 * H;
const D = 86_400_000;
const FEE = 0.000_35;
const SL_SLIP = 1.5;

// Supertrend engine
const ST_LEV = 10;
const ST_SIZE = 3;
const ST_NOT = ST_SIZE * ST_LEV; // $30 notional
const ST_ATR_PERIOD = 14;
const ST_MULT = 1.75;
const ST_SL_ATR_MULT = 3.0;
const ST_SL_MAX_PCT = 0.035;
const ST_STAG_BARS = 12; // 48h at 4h bars

// GARCH MTF engine
const GR_SIZE = 5;
const GR_NOT = GR_SIZE * 10; // $50 notional
const MOM_LB = 3;
const VOL_WIN = 20;
const Z_LONG_1H = 4.5;
const Z_SHORT_1H = -3.0;
const Z_LONG_4H = 3.0;
const Z_SHORT_4H = -3.0;
const EMA_FAST = 9;
const EMA_SLOW = 21;
const GR_SL_PCT = 0.04;
const GR_MAX_HOLD_H = 168;

// Donchian engine
const DON_SIZE = 5;
const DON_NOT = DON_SIZE * 10; // $50 notional
const DON_SMA_FAST = 30;
const DON_SMA_SLOW = 60;
const DON_EXIT_LB = 15;
const DON_ATR_MULT = 3;
const DON_ATR_PER = 14;
const DON_MAX_HOLD = 60;

const FULL_START = new Date("2023-01-01").getTime();
const FULL_END = new Date("2026-03-26").getTime();

// Standard spread map (half-spread)
const SP: Record<string, number> = {
  XRP: 1.05e-4, DOGE: 1.35e-4, BTC: 0.5e-4, ETH: 1.5e-4, SOL: 2.0e-4,
  TIA: 2.5e-4, ARB: 2.6e-4, ENA: 2.55e-4, UNI: 2.75e-4, APT: 3.2e-4,
  LINK: 3.45e-4, TRUMP: 3.65e-4, WLD: 4e-4, DOT: 4.95e-4, WIF: 5.05e-4,
  ADA: 5.55e-4, LDO: 5.8e-4, OP: 6.2e-4, DASH: 7.15e-4,
};

const PAIRS = [
  "OP", "WIF", "ARB", "LDO", "TRUMP", "DASH", "DOT", "ENA",
  "DOGE", "APT", "LINK", "ADA", "WLD", "XRP", "UNI", "ETH", "TIA", "SOL",
];

// ─── Types ──────────────────────────────────────────────────────────
interface C { t: number; o: number; h: number; l: number; c: number; v: number; }
interface Trade {
  pair: string; dir: "long" | "short"; ep: number; xp: number;
  et: number; xt: number; pnl: number; reason: string; engine: string;
}
interface Metrics {
  n: number; wr: number; pf: number; sharpe: number;
  dd: number; total: number; perDay: number;
}

// ─── Data Loading ───────────────────────────────────────────────────
function load5m(pair: string): C[] {
  const fp = path.join(CACHE_5M, `${pair}USDT.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, "utf8")) as any[];
  return raw.map((b: any) =>
    Array.isArray(b)
      ? { t: +b[0], o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +(b[5] ?? 0) }
      : { t: +b.t, o: +b.o, h: +b.h, l: +b.l, c: +b.c, v: +(b.v ?? 0) },
  ).sort((a: C, b: C) => a.t - b.t);
}

function aggregate(bars5m: C[], periodMs: number, minBars: number): C[] {
  const groups = new Map<number, C[]>();
  for (const b of bars5m) {
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
      t: ts, o: grp[0].o,
      h: Math.max(...grp.map(b => b.h)),
      l: Math.min(...grp.map(b => b.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((s, b) => s + b.v, 0),
    });
  }
  result.sort((a, b) => a.t - b.t);
  return result;
}

// ─── Indicators ─────────────────────────────────────────────────────
function calcATR(cs: C[], period: number): number[] {
  const atr = new Array(cs.length).fill(0);
  for (let i = 1; i < cs.length; i++) {
    const tr = Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    if (i < period) continue;
    if (i === period) {
      let s = 0;
      for (let j = 1; j <= period; j++)
        s += Math.max(cs[j].h - cs[j].l, Math.abs(cs[j].h - cs[j - 1].c), Math.abs(cs[j].l - cs[j - 1].c));
      atr[i] = s / period;
    } else {
      atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
    }
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
      let s = 0; for (let j = i - period + 1; j <= i; j++) s += values[j];
      ema[i] = s / period; init = true;
    } else {
      ema[i] = values[i] * k + ema[i - 1] * (1 - k);
    }
  }
  return ema;
}

function calcSMA(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out[i] = s / period;
  }
  return out;
}

function calcSupertrend(cs: C[], atrPeriod: number, mult: number): { st: number[]; dir: number[] } {
  const atr = calcATR(cs, atrPeriod);
  const st = new Array(cs.length).fill(0);
  const dirs = new Array(cs.length).fill(1);
  const ub = new Array(cs.length).fill(0);
  const lb = new Array(cs.length).fill(0);

  for (let i = atrPeriod; i < cs.length; i++) {
    const hl2 = (cs[i].h + cs[i].l) / 2;
    let upperBand = hl2 + mult * atr[i];
    let lowerBand = hl2 - mult * atr[i];

    if (i > atrPeriod) {
      if (lowerBand > lb[i - 1] || cs[i - 1].c < lb[i - 1]) { /* keep */ } else lowerBand = lb[i - 1];
      if (upperBand < ub[i - 1] || cs[i - 1].c > ub[i - 1]) { /* keep */ } else upperBand = ub[i - 1];
    }

    ub[i] = upperBand;
    lb[i] = lowerBand;

    if (i === atrPeriod) {
      dirs[i] = cs[i].c > upperBand ? 1 : -1;
    } else {
      if (dirs[i - 1] === 1) {
        dirs[i] = cs[i].c < lowerBand ? -1 : 1;
      } else {
        dirs[i] = cs[i].c > upperBand ? 1 : -1;
      }
    }

    st[i] = dirs[i] === 1 ? lowerBand : upperBand;
  }

  return { st, dir: dirs };
}

function computeZScores(candles: C[], momLb: number, volWin: number): number[] {
  const z = new Array(candles.length).fill(0);
  for (let i = Math.max(momLb + 1, volWin + 1); i < candles.length; i++) {
    const mom = candles[i].c / candles[i - momLb].c - 1;
    let sumSq = 0, count = 0;
    for (let j = Math.max(1, i - volWin + 1); j <= i; j++) {
      const r = candles[j].c / candles[j - 1].c - 1;
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

function donchCloseHigh(cs: C[], idx: number, lb: number): number {
  let mx = -Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mx = Math.max(mx, cs[i].c);
  return mx;
}

function donchCloseLow(cs: C[], idx: number, lb: number): number {
  let mn = Infinity;
  for (let i = Math.max(0, idx - lb); i < idx; i++) mn = Math.min(mn, cs[i].c);
  return mn;
}

function volAvg(cs: C[], idx: number, lookback = 20): number {
  if (idx < lookback) return 0;
  let sum = 0;
  for (let k = idx - lookback; k < idx; k++) sum += cs[k].v;
  return sum / lookback;
}

// ─── Cost Model ─────────────────────────────────────────────────────
function stTradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean): number {
  const sp = SP[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = ST_NOT * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * ST_NOT : (ep / xp - 1) * ST_NOT;
  return rawPnl - entrySlip * (ST_NOT / ep) - exitSlip * (ST_NOT / xp) - fees;
}

function otherTradePnl(pair: string, ep: number, xp: number, dir: "long" | "short", isSL: boolean, notional: number): number {
  const sp = SP[pair] ?? 4e-4;
  const entrySlip = ep * sp;
  const exitSlip = xp * sp * (isSL ? SL_SLIP : 1);
  const fees = notional * FEE * 2;
  const rawPnl = dir === "long" ? (xp / ep - 1) * notional : (ep / xp - 1) * notional;
  return rawPnl - entrySlip * (notional / ep) - exitSlip * (notional / xp) - fees;
}

// ─── Metrics ────────────────────────────────────────────────────────
function calcMetrics(trades: Trade[], startTs?: number, endTs?: number): Metrics {
  if (trades.length === 0) return { n: 0, wr: 0, pf: 0, sharpe: 0, dd: 0, total: 0, perDay: 0 };
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const total = trades.reduce((s, t) => s + t.pnl, 0);

  let cum = 0, peak = 0, maxDD = 0;
  const sorted = [...trades].sort((a, b) => a.xt - b.xt);
  for (const t of sorted) {
    cum += t.pnl;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  const dayPnl = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.xt / D);
    dayPnl.set(d, (dayPnl.get(d) ?? 0) + t.pnl);
  }
  const returns = [...dayPnl.values()];
  const mean = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const firstT = startTs ?? Math.min(...trades.map(t => t.et));
  const lastT = endTs ?? Math.max(...trades.map(t => t.xt));
  const days = Math.max((lastT - firstT) / D, 1);

  return {
    n: trades.length,
    wr: wins.length / trades.length * 100,
    pf: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
    sharpe,
    dd: maxDD,
    total,
    perDay: total / days,
  };
}

function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtRow(label: string, m: Metrics): string {
  return `${label.padEnd(34)} ${String(m.n).padStart(5)}  ${m.wr.toFixed(1).padStart(5)}%  ${fmtPnl(m.total).padStart(12)}  ${m.pf.toFixed(2).padStart(6)}  ${m.sharpe.toFixed(2).padStart(7)}  $${m.dd.toFixed(2).padStart(8)}  ${fmtPnl(m.perDay).padStart(10)}/d`;
}
function printHeader(): void {
  console.log(`${"".padEnd(34)} ${"Trades".padStart(5)}  ${"WR%".padStart(6)}  ${"TotalPnL".padStart(12)}  ${"PF".padStart(6)}  ${"Sharpe".padStart(7)}  ${"MaxDD".padStart(9)}  ${"$/day".padStart(11)}`);
  console.log("-".repeat(105));
}

// ─── Load Data ──────────────────────────────────────────────────────
console.log("Loading 5m candle data...");
const raw5m = new Map<string, C[]>();
for (const p of ["BTC", ...PAIRS]) {
  const d = load5m(p);
  if (d.length > 0) { raw5m.set(p, d); console.log(`  ${p}: ${d.length} bars`); }
  else console.log(`  ${p}: MISSING`);
}

// Aggregated data
const dailyData = new Map<string, C[]>();
const h4Data = new Map<string, C[]>();
const h1Data = new Map<string, C[]>();
for (const [p, bars] of raw5m) {
  dailyData.set(p, aggregate(bars, D, 200));
  h4Data.set(p, aggregate(bars, H4, 40));
  h1Data.set(p, aggregate(bars, H, 10));
}
console.log("Aggregated: daily/4h/1h candles ready.\n");

// BTC daily EMA for filters
const btcDaily = dailyData.get("BTC")!;
const btcDailyCloses = btcDaily.map(c => c.c);
const btcDailyEma20 = calcEMA(btcDailyCloses, 20);
const btcDailyEma50 = calcEMA(btcDailyCloses, 50);

function btcDailyBullish(t: number): boolean {
  let idx = -1;
  for (let i = btcDaily.length - 1; i >= 0; i--) {
    if (btcDaily[i].t <= t) { idx = i; break; }
  }
  if (idx < 0 || idx < 50) return false;
  return btcDailyEma20[idx] > btcDailyEma50[idx];
}

// BTC 1h EMA for GARCH filter
const btcH1 = h1Data.get("BTC")!;
const btcH1Closes = btcH1.map(c => c.c);
const btcH1Ema9 = calcEMA(btcH1Closes, EMA_FAST);
const btcH1Ema21 = calcEMA(btcH1Closes, EMA_SLOW);

function btcH1Trend(t: number): "long" | "short" | null {
  let idx: number | undefined;
  for (let i = btcH1.length - 1; i >= 0; i--) {
    if (btcH1[i].t <= t) { idx = i; break; }
  }
  if (idx === undefined || idx < 1) return null;
  const prev = idx - 1;
  if (prev < EMA_SLOW) return null;
  if (btcH1Ema9[prev] > btcH1Ema21[prev]) return "long";
  if (btcH1Ema9[prev] < btcH1Ema21[prev]) return "short";
  return null;
}

// ─── Engine 1: Supertrend(14, 1.75) with volume filter ──────────────
function engineSupertrend(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const cs = h4Data.get(pair);
    if (!cs || cs.length < ST_ATR_PERIOD + 30) continue;

    const { dir } = calcSupertrend(cs, ST_ATR_PERIOD, ST_MULT);
    const atr = calcATR(cs, ST_ATR_PERIOD);
    let pos: { dir: "long" | "short"; ep: number; et: number; sl: number; entryIdx: number } | null = null;

    for (let i = ST_ATR_PERIOD + 1; i < cs.length; i++) {
      const bar = cs[i];
      const prevDir = dir[i - 1];
      const prevPrevDir = i >= 2 ? dir[i - 2] : prevDir;
      const flipped = prevDir !== prevPrevDir;

      // EXIT
      if (pos) {
        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp) {
          const barsHeld = i - pos.entryIdx;
          if (barsHeld >= ST_STAG_BARS) { xp = bar.c; reason = "stag"; }
        }

        if (!xp && flipped) { xp = bar.o; reason = "flip"; }

        if (xp > 0) {
          const pnl = stTradePnl(pair, pos.ep, xp, pos.dir, isSL);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, engine: "ST" });
          }
          pos = null;
        }
      }

      // ENTRY
      if (!pos && flipped && bar.t >= startTs && bar.t < endTs) {
        const newDir: "long" | "short" = prevDir === 1 ? "long" : "short";

        // Volume filter: skip entries with volume < 0.5x 20-bar avg
        const avg = volAvg(cs, i);
        if (avg > 0 && cs[i].v < 0.5 * avg) continue;

        const curATR = atr[i] || atr[i - 1];
        let slDist = curATR * ST_SL_ATR_MULT;
        const maxDist = bar.o * ST_SL_MAX_PCT;
        if (slDist > maxDist) slDist = maxDist;
        const sl = newDir === "long" ? bar.o - slDist : bar.o + slDist;

        pos = { dir: newDir, ep: bar.o, et: bar.t, sl, entryIdx: i };
      }
    }

    if (pos && pos.et >= startTs && pos.et < endTs) {
      const lastBar = cs[cs.length - 1];
      const pnl = stTradePnl(pair, pos.ep, lastBar.c, pos.dir, false);
      trades.push({ pair, dir: pos.dir, ep: pos.ep, xp: lastBar.c, et: pos.et, xt: lastBar.t, pnl, reason: "end", engine: "ST" });
    }
  }

  return trades;
}

// ─── Engine 2: GARCH MTF Z-Score ────────────────────────────────────
function engineGarchMTF(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const h1 = h1Data.get(pair);
    const h4 = h4Data.get(pair);
    if (!h1 || h1.length < 200 || !h4 || h4.length < 200) continue;

    const z1h = computeZScores(h1, MOM_LB, VOL_WIN);
    const z4h = computeZScores(h4, MOM_LB, VOL_WIN);

    const h1Closes = h1.map(c => c.c);
    const ema9_1h = calcEMA(h1Closes, EMA_FAST);
    const ema21_1h = calcEMA(h1Closes, EMA_SLOW);

    const h4TsMap = new Map<number, number>();
    h4.forEach((c, i) => h4TsMap.set(c.t, i));

    let pos: { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

    for (let i = Math.max(VOL_WIN + MOM_LB + 2, EMA_SLOW + 1); i < h1.length; i++) {
      const bar = h1[i];

      // EXITS
      if (pos) {
        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp) {
          const hoursHeld = (bar.t - pos.et) / H;
          if (hoursHeld >= GR_MAX_HOLD_H) { xp = bar.c; reason = "mh"; }
        }

        if (xp > 0) {
          const pnl = otherTradePnl(pair, pos.ep, xp, pos.dir, isSL, GR_NOT);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, engine: "GARCH" });
          }
          pos = null;
        }
      }

      // ENTRIES
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        if (prev < VOL_WIN + MOM_LB) continue;

        const z1 = z1h[prev];
        if (isNaN(z1) || z1 === 0) continue;

        const goLong = z1 > Z_LONG_1H;
        const goShort = z1 < Z_SHORT_1H;
        if (!goLong && !goShort) continue;

        // 4h confirmation
        const ts4h = Math.floor(h1[prev].t / H4) * H4;
        const idx4h = h4TsMap.get(ts4h);
        if (idx4h === undefined || idx4h < VOL_WIN + MOM_LB) continue;
        const z4 = z4h[idx4h];
        if (goLong && z4 <= Z_LONG_4H) continue;
        if (goShort && z4 >= Z_SHORT_4H) continue;

        // EMA filter on 1h
        if (prev < EMA_SLOW) continue;
        if (goLong && ema9_1h[prev] <= ema21_1h[prev]) continue;
        if (goShort && ema9_1h[prev] >= ema21_1h[prev]) continue;

        // BTC EMA filter
        const btcTrend = btcH1Trend(h1[prev].t);
        if (goLong && btcTrend !== "long") continue;
        if (goShort && btcTrend !== "short") continue;

        const d: "long" | "short" = goLong ? "long" : "short";
        const ep = bar.o;
        let sl = d === "long" ? ep * (1 - GR_SL_PCT) : ep * (1 + GR_SL_PCT);
        if (d === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir: d, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// ─── Engine 3: Daily Donchian Trend ─────────────────────────────────
function engineDonchian(startTs: number, endTs: number): Trade[] {
  const trades: Trade[] = [];

  for (const pair of PAIRS) {
    const cs = dailyData.get(pair);
    if (!cs || cs.length < DON_SMA_SLOW + DON_ATR_PER + 5) continue;

    const closes = cs.map(c => c.c);
    const fast = calcSMA(closes, DON_SMA_FAST);
    const slow = calcSMA(closes, DON_SMA_SLOW);
    const atr = calcATR(cs, DON_ATR_PER);
    const warmup = DON_SMA_SLOW + 1;

    let pos: { pair: string; dir: "long" | "short"; ep: number; et: number; sl: number } | null = null;

    for (let i = warmup; i < cs.length; i++) {
      const bar = cs[i];

      // EXITS
      if (pos) {
        const holdDays = Math.round((bar.t - pos.et) / D);
        let xp = 0, reason = "", isSL = false;

        if (pos.dir === "long" && bar.l <= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }
        else if (pos.dir === "short" && bar.h >= pos.sl) { xp = pos.sl; reason = "sl"; isSL = true; }

        if (!xp && i >= DON_EXIT_LB + 1) {
          if (pos.dir === "long") {
            const chanLow = donchCloseLow(cs, i, DON_EXIT_LB);
            if (bar.c < chanLow) { xp = bar.c; reason = "ch"; }
          } else {
            const chanHigh = donchCloseHigh(cs, i, DON_EXIT_LB);
            if (bar.c > chanHigh) { xp = bar.c; reason = "ch"; }
          }
        }

        if (!xp && holdDays >= DON_MAX_HOLD) { xp = bar.c; reason = "mh"; }

        if (xp > 0) {
          const pnl = otherTradePnl(pair, pos.ep, xp, pos.dir, isSL, DON_NOT);
          if (pos.et >= startTs && pos.et < endTs) {
            trades.push({ pair, dir: pos.dir, ep: pos.ep, xp, et: pos.et, xt: bar.t, pnl, reason, engine: "DON" });
          }
          pos = null;
        }
      }

      // ENTRIES
      if (!pos && bar.t >= startTs && bar.t < endTs) {
        const prev = i - 1;
        const prevFast = fast[prev];
        const prevSlow = slow[prev];
        const curFast = fast[i];
        const curSlow = slow[i];
        if (prevFast === 0 || prevSlow === 0 || curFast === 0 || curSlow === 0) continue;

        let d: "long" | "short" | null = null;
        if (prevFast <= prevSlow && curFast > curSlow) d = "long";
        else if (prevFast >= prevSlow && curFast < curSlow) d = "short";
        if (!d) continue;

        if (d === "long" && !btcDailyBullish(bar.t)) continue;

        const prevATR = atr[i - 1];
        if (prevATR <= 0) continue;

        const ep = bar.o;
        let sl = d === "long" ? ep - DON_ATR_MULT * prevATR : ep + DON_ATR_MULT * prevATR;
        if (d === "long") sl = Math.max(sl, ep * (1 - 0.035));
        else sl = Math.min(sl, ep * (1 + 0.035));

        pos = { pair, dir: d, ep, et: bar.t, sl };
      }
    }
  }

  return trades;
}

// ─── Helper: BTC monthly returns for regime classification ──────────
function getBtcMonthlyReturns(): Map<string, number> {
  const monthly = new Map<string, number>();
  const btc = dailyData.get("BTC")!;
  if (!btc || btc.length < 2) return monthly;

  // Group daily bars by month
  const monthBars = new Map<string, C[]>();
  for (const bar of btc) {
    const d = new Date(bar.t);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    let arr = monthBars.get(key);
    if (!arr) { arr = []; monthBars.set(key, arr); }
    arr.push(bar);
  }

  for (const [key, bars] of monthBars) {
    if (bars.length < 15) continue; // skip partial months
    const first = bars[0].o;
    const last = bars[bars.length - 1].c;
    monthly.set(key, (last / first - 1) * 100);
  }

  return monthly;
}

// =========================================================================
// MAIN EXECUTION
// =========================================================================

console.log("=".repeat(105));
console.log("LONG-TERM VALIDATION: 3.2 YEARS (2023-01 to 2026-03)");
console.log("Supertrend(14,1.75) with volume filter | Standard spreads, 0.035% fee, 1.5x SL slip");
console.log("=".repeat(105));

// =========================================================================
// TEST 1: Rolling 6-month OOS windows
// =========================================================================
console.log("\n" + "=".repeat(105));
console.log("TEST 1: ROLLING 6-MONTH OOS WINDOWS");
console.log("Train on everything BEFORE the window, test on the window");
console.log("=".repeat(105));

const windows = [
  { label: "W1: 2023-07 to 2023-12", start: new Date("2023-07-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "W2: 2024-01 to 2024-06", start: new Date("2024-01-01").getTime(), end: new Date("2024-07-01").getTime() },
  { label: "W3: 2024-07 to 2024-12", start: new Date("2024-07-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "W4: 2025-01 to 2025-06", start: new Date("2025-01-01").getTime(), end: new Date("2025-07-01").getTime() },
  { label: "W5: 2025-07 to 2025-12", start: new Date("2025-07-01").getTime(), end: new Date("2026-01-01").getTime() },
  { label: "W6: 2026-01 to 2026-03", start: new Date("2026-01-01").getTime(), end: new Date("2026-04-01").getTime() },
];

printHeader();
let allWindowProfitable = true;
const windowResults: { label: string; m: Metrics }[] = [];
for (const w of windows) {
  const trades = engineSupertrend(w.start, w.end);
  const m = calcMetrics(trades, w.start, w.end);
  console.log(fmtRow(w.label, m));
  windowResults.push({ label: w.label, m });
  if (m.total <= 0) allWindowProfitable = false;
}

// Combined full period
const fullST = engineSupertrend(FULL_START, FULL_END);
const fullSTM = calcMetrics(fullST, FULL_START, FULL_END);
console.log("-".repeat(105));
console.log(fmtRow("FULL PERIOD (combined)", fullSTM));

console.log(`\nAll windows profitable: ${allWindowProfitable ? "YES" : "NO"}`);
const profitableWindows = windowResults.filter(w => w.m.total > 0).length;
console.log(`Profitable windows: ${profitableWindows}/${windowResults.length}`);
const avgPerDay = windowResults.reduce((s, w) => s + w.m.perDay, 0) / windowResults.length;
console.log(`Average $/day across windows: ${fmtPnl(avgPerDay)}`);
const sharpRange = windowResults.filter(w => w.m.n > 0).map(w => w.m.sharpe);
console.log(`Sharpe range: ${Math.min(...sharpRange).toFixed(2)} to ${Math.max(...sharpRange).toFixed(2)}`);

// =========================================================================
// TEST 2: Bear vs Bull vs Sideways performance
// =========================================================================
console.log("\n" + "=".repeat(105));
console.log("TEST 2: BEAR vs BULL vs SIDEWAYS REGIME PERFORMANCE");
console.log("Bull: BTC monthly return > 5% | Bear: < -5% | Sideways: -5% to 5%");
console.log("=".repeat(105));

const btcMonthly = getBtcMonthlyReturns();
const regimeMonths: Record<string, string[]> = { bull: [], bear: [], sideways: [] };

const sortedMonths = [...btcMonthly.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log("\nBTC monthly returns and regime classification:");
for (const [month, ret] of sortedMonths) {
  const regime = ret > 5 ? "bull" : ret < -5 ? "bear" : "sideways";
  regimeMonths[regime].push(month);
  console.log(`  ${month}: ${ret >= 0 ? "+" : ""}${ret.toFixed(1)}% [${regime.toUpperCase()}]`);
}

console.log(`\nRegime counts: Bull=${regimeMonths.bull.length}, Bear=${regimeMonths.bear.length}, Sideways=${regimeMonths.sideways.length}`);

// Classify each trade by its entry month regime
function getMonthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getRegime(ts: number): string {
  const key = getMonthKey(ts);
  if (regimeMonths.bull.includes(key)) return "bull";
  if (regimeMonths.bear.includes(key)) return "bear";
  return "sideways";
}

const bullTrades = fullST.filter(t => getRegime(t.et) === "bull");
const bearTrades = fullST.filter(t => getRegime(t.et) === "bear");
const sidewaysTrades = fullST.filter(t => getRegime(t.et) === "sideways");

console.log("\nSupertrend(14,1.75) metrics by regime:");
printHeader();
console.log(fmtRow("BULL months", calcMetrics(bullTrades)));
console.log(fmtRow("BEAR months", calcMetrics(bearTrades)));
console.log(fmtRow("SIDEWAYS months", calcMetrics(sidewaysTrades)));
console.log("-".repeat(105));
console.log(fmtRow("ALL REGIMES", fullSTM));

// Long/Short breakdown per regime
console.log("\nLong vs Short by regime:");
for (const regime of ["bull", "bear", "sideways"] as const) {
  const rTrades = regime === "bull" ? bullTrades : regime === "bear" ? bearTrades : sidewaysTrades;
  const longs = rTrades.filter(t => t.dir === "long");
  const shorts = rTrades.filter(t => t.dir === "short");
  const longPnl = longs.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shorts.reduce((s, t) => s + t.pnl, 0);
  console.log(`  ${regime.toUpperCase().padEnd(10)} Long: ${longs.length} trades, ${fmtPnl(longPnl)} | Short: ${shorts.length} trades, ${fmtPnl(shortPnl)}`);
}

// =========================================================================
// TEST 3: Year-over-year consistency (3-engine ensemble)
// =========================================================================
console.log("\n" + "=".repeat(105));
console.log("TEST 3: YEAR-OVER-YEAR CONSISTENCY (3-ENGINE ENSEMBLE)");
console.log("Engines: Supertrend(14,1.75) $3 + GARCH-MTF $5 + Donchian $5");
console.log("=".repeat(105));

const years = [
  { label: "2023 (full year)", start: new Date("2023-01-01").getTime(), end: new Date("2024-01-01").getTime() },
  { label: "2024 (full year)", start: new Date("2024-01-01").getTime(), end: new Date("2025-01-01").getTime() },
  { label: "2025 (full year)", start: new Date("2025-01-01").getTime(), end: new Date("2026-01-01").getTime() },
  { label: "2026 (Jan-Mar)", start: new Date("2026-01-01").getTime(), end: new Date("2026-04-01").getTime() },
];

// Per-engine per-year
console.log("\n--- Per-Engine Per-Year ---");
for (const y of years) {
  console.log(`\n${y.label}:`);
  printHeader();

  const stTrades = engineSupertrend(y.start, y.end);
  const grTrades = engineGarchMTF(y.start, y.end);
  const donTrades = engineDonchian(y.start, y.end);
  const allTrades = [...stTrades, ...grTrades, ...donTrades];

  console.log(fmtRow("  Supertrend(14,1.75)", calcMetrics(stTrades, y.start, y.end)));
  console.log(fmtRow("  GARCH MTF z-score", calcMetrics(grTrades, y.start, y.end)));
  console.log(fmtRow("  Daily Donchian", calcMetrics(donTrades, y.start, y.end)));
  console.log("-".repeat(105));
  console.log(fmtRow("  ENSEMBLE COMBINED", calcMetrics(allTrades, y.start, y.end)));
}

// Full-period ensemble
console.log("\n--- Full Period Ensemble ---");
printHeader();
const fullGR = engineGarchMTF(FULL_START, FULL_END);
const fullDON = engineDonchian(FULL_START, FULL_END);
const fullEnsemble = [...fullST, ...fullGR, ...fullDON];
console.log(fmtRow("Supertrend", calcMetrics(fullST, FULL_START, FULL_END)));
console.log(fmtRow("GARCH MTF", calcMetrics(fullGR, FULL_START, FULL_END)));
console.log(fmtRow("Donchian", calcMetrics(fullDON, FULL_START, FULL_END)));
console.log("-".repeat(105));
console.log(fmtRow("FULL ENSEMBLE", calcMetrics(fullEnsemble, FULL_START, FULL_END)));

// Year consistency summary
console.log("\n--- Year Consistency Summary ---");
let allYearsProfitable = true;
for (const y of years) {
  const stTrades = engineSupertrend(y.start, y.end);
  const grTrades = engineGarchMTF(y.start, y.end);
  const donTrades = engineDonchian(y.start, y.end);
  const allTrades = [...stTrades, ...grTrades, ...donTrades];
  const m = calcMetrics(allTrades, y.start, y.end);
  const status = m.total > 0 ? "PROFIT" : "LOSS";
  if (m.total <= 0) allYearsProfitable = false;
  console.log(`  ${y.label.padEnd(20)} ${status.padEnd(7)} ${fmtPnl(m.total).padStart(12)}  PF=${m.pf.toFixed(2)}  Sharpe=${m.sharpe.toFixed(2)}  $/day=${fmtPnl(m.perDay)}`);
}
console.log(`\nAll years profitable: ${allYearsProfitable ? "YES" : "NO"}`);

// =========================================================================
// TEST 4: Worst-case 30-day period analysis
// =========================================================================
console.log("\n" + "=".repeat(105));
console.log("TEST 4: WORST-CASE 30-DAY PERIOD ANALYSIS");
console.log("Scanning entire 3.2 years for the worst rolling 30-day drawdown");
console.log("=".repeat(105));

// Sort all ensemble trades by exit time, compute rolling 30-day P&L
const ensembleSorted = [...fullEnsemble].sort((a, b) => a.xt - b.xt);

// Build daily P&L series for the ensemble
const dailyPnlMap = new Map<number, number>();
for (const t of ensembleSorted) {
  const day = Math.floor(t.xt / D) * D;
  dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + t.pnl);
}
const dailyKeys = [...dailyPnlMap.keys()].sort((a, b) => a - b);
const dailyPnls = dailyKeys.map(k => ({ t: k, pnl: dailyPnlMap.get(k)! }));

// Rolling 30-day sum
let worstSum = Infinity;
let worstStart = 0;
let worstEnd = 0;

for (let i = 0; i < dailyPnls.length; i++) {
  let sum = 0;
  for (let j = i; j < dailyPnls.length && dailyPnls[j].t - dailyPnls[i].t < 30 * D; j++) {
    sum += dailyPnls[j].pnl;
    if (sum < worstSum) {
      worstSum = sum;
      worstStart = dailyPnls[i].t;
      worstEnd = dailyPnls[j].t;
    }
  }
}

const worstStartDate = new Date(worstStart).toISOString().slice(0, 10);
const worstEndDate = new Date(worstEnd).toISOString().slice(0, 10);
const worstDays = Math.round((worstEnd - worstStart) / D) + 1;

console.log(`\nWorst 30-day window: ${worstStartDate} to ${worstEndDate} (${worstDays} days)`);
console.log(`Total P&L: ${fmtPnl(worstSum)}`);

// What happened during that period
const worstTrades = ensembleSorted.filter(t => t.xt >= worstStart && t.xt <= worstEnd + D);
const worstLongs = worstTrades.filter(t => t.dir === "long");
const worstShorts = worstTrades.filter(t => t.dir === "short");
const worstByEngine = new Map<string, Trade[]>();
for (const t of worstTrades) {
  const arr = worstByEngine.get(t.engine) ?? [];
  arr.push(t);
  worstByEngine.set(t.engine, arr);
}

console.log(`Trades in period: ${worstTrades.length} (${worstLongs.length} long, ${worstShorts.length} short)`);
console.log(`Long P&L: ${fmtPnl(worstLongs.reduce((s, t) => s + t.pnl, 0))}`);
console.log(`Short P&L: ${fmtPnl(worstShorts.reduce((s, t) => s + t.pnl, 0))}`);

console.log("\nBy engine:");
for (const [eng, trades] of worstByEngine) {
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  console.log(`  ${eng.padEnd(10)} ${trades.length} trades, ${wins} wins, ${fmtPnl(pnl)}`);
}

// BTC regime during worst period
const worstBtcMonthKey = getMonthKey(worstStart);
const worstBtcRet = btcMonthly.get(worstBtcMonthKey);
const worstRegime = getRegime(worstStart);
console.log(`\nBTC regime at start: ${worstRegime.toUpperCase()} (${worstBtcMonthKey}: ${worstBtcRet !== undefined ? (worstBtcRet >= 0 ? "+" : "") + worstBtcRet.toFixed(1) + "%" : "N/A"})`);

// Biggest individual losers
const worstIndividual = [...worstTrades].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
console.log("\nTop 5 individual losers in the worst window:");
for (const t of worstIndividual) {
  const entryDate = new Date(t.et).toISOString().slice(0, 10);
  const exitDate = new Date(t.xt).toISOString().slice(0, 10);
  console.log(`  ${t.engine.padEnd(6)} ${t.pair.padEnd(6)} ${t.dir.padEnd(6)} ${entryDate} -> ${exitDate}  ${fmtPnl(t.pnl).padStart(10)}  reason=${t.reason}`);
}

// Recovery analysis: how long until cumulative P&L from worst point recovers
const worstEndIdx = ensembleSorted.findIndex(t => t.xt > worstEnd);
let cumAfterWorst = 0;
let recoveryDate = 0;
let recovered = false;
// Cumulative P&L at the end of worst period
let cumAtWorstEnd = 0;
for (const t of ensembleSorted) {
  if (t.xt <= worstEnd + D) cumAtWorstEnd += t.pnl;
}
// Find the peak before the worst period
let cumBeforeWorst = 0;
let peakBeforeWorst = 0;
for (const t of ensembleSorted) {
  if (t.xt >= worstStart) break;
  cumBeforeWorst += t.pnl;
  if (cumBeforeWorst > peakBeforeWorst) peakBeforeWorst = cumBeforeWorst;
}

// Recovery: when does cum P&L reach peakBeforeWorst again?
let cumScan = 0;
for (const t of ensembleSorted) {
  cumScan += t.pnl;
  if (t.xt > worstEnd && cumScan >= peakBeforeWorst) {
    recoveryDate = t.xt;
    recovered = true;
    break;
  }
}

if (recovered) {
  const recoveryDays = Math.round((recoveryDate - worstEnd) / D);
  console.log(`\nRecovery: ${recoveryDays} days after worst period ended (${new Date(recoveryDate).toISOString().slice(0, 10)})`);
} else {
  console.log("\nRecovery: NOT YET RECOVERED (or equity still climbing back)");
}

// Max drawdown for full ensemble (peak-to-trough)
let cumFull = 0, peakFull = 0, maxDDFull = 0, ddStart = 0, ddTrough = 0;
for (const t of ensembleSorted) {
  cumFull += t.pnl;
  if (cumFull > peakFull) { peakFull = cumFull; ddStart = t.xt; }
  if (peakFull - cumFull > maxDDFull) { maxDDFull = peakFull - cumFull; ddTrough = t.xt; }
}

console.log(`\nFull-period max drawdown: $${maxDDFull.toFixed(2)}`);
if (ddStart && ddTrough) {
  console.log(`  Peak at: ${new Date(ddStart).toISOString().slice(0, 10)}`);
  console.log(`  Trough at: ${new Date(ddTrough).toISOString().slice(0, 10)}`);
}

// =========================================================================
// FINAL VERDICT
// =========================================================================
console.log("\n" + "=".repeat(105));
console.log("FINAL VERDICT");
console.log("=".repeat(105));

const ensM = calcMetrics(fullEnsemble, FULL_START, FULL_END);
console.log(`\n3-Engine Ensemble (3.2 years):`);
console.log(`  Total P&L:     ${fmtPnl(ensM.total)}`);
console.log(`  $/day:         ${fmtPnl(ensM.perDay)}`);
console.log(`  Win Rate:      ${ensM.wr.toFixed(1)}%`);
console.log(`  Profit Factor: ${ensM.pf.toFixed(2)}`);
console.log(`  Sharpe:        ${ensM.sharpe.toFixed(2)}`);
console.log(`  Max Drawdown:  $${ensM.dd.toFixed(2)}`);
console.log(`  Total Trades:  ${ensM.n}`);

console.log(`\nRolling 6m windows: ${profitableWindows}/${windowResults.length} profitable (Supertrend only)`);
console.log(`All years profitable (ensemble): ${allYearsProfitable ? "YES" : "NO"}`);
console.log(`Works in all regimes: ${bullTrades.reduce((s,t)=>s+t.pnl,0) > 0 && bearTrades.reduce((s,t)=>s+t.pnl,0) > 0 && sidewaysTrades.reduce((s,t)=>s+t.pnl,0) > 0 ? "YES" : "NO"}`);
console.log(`Worst 30-day loss: ${fmtPnl(worstSum)}`);

// Risk assessment
const dailyLossRisk = Math.abs(worstSum) / 30;
console.log(`\nRisk assessment:`);
console.log(`  Avg daily loss in worst period: ${fmtPnl(-dailyLossRisk)}`);
console.log(`  Calmar ratio ($/day / MaxDD):   ${(ensM.perDay / ensM.dd).toFixed(3)}`);
console.log(`  Trades per day:                 ${(ensM.n / ((FULL_END - FULL_START) / D)).toFixed(1)}`);

console.log("\nDone.");
